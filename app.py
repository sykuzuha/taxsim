import csv
import hashlib
import io
import sqlite3
from datetime import datetime
from pathlib import Path

from flask import Flask, Response, g, jsonify, render_template, request

app = Flask(__name__)
app.config["DATABASE"] = Path(app.root_path) / "tax_profiles.db"

PROFILE_FIELDS = (
    "filing_status",
    "state",
    "residency",
    "salary",
    "other_income",
    "deduction_type",
    "deductions",
    "short_term",
    "long_term",
    "carryforward",
    "amt_credit",
    "growth",
    "inflation",
)


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_error=None):
    database = g.pop("db", None)
    if database is not None:
        database.close()


def init_db():
    database = get_db()
    database.execute(
        """
        CREATE TABLE IF NOT EXISTS tax_profiles (
            tax_year INTEGER PRIMARY KEY,
            filing_status TEXT NOT NULL DEFAULT 'Single',
            state TEXT NOT NULL DEFAULT 'California',
            residency TEXT NOT NULL DEFAULT 'Full-year resident',
            salary REAL NOT NULL DEFAULT 0,
            other_income REAL NOT NULL DEFAULT 0,
            deduction_type TEXT NOT NULL DEFAULT 'standard',
            deductions REAL NOT NULL DEFAULT 0,
            short_term REAL NOT NULL DEFAULT 0,
            long_term REAL NOT NULL DEFAULT 0,
            carryforward REAL NOT NULL DEFAULT 0,
            amt_credit REAL NOT NULL DEFAULT 0,
            growth REAL NOT NULL DEFAULT 0,
            inflation REAL NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    database.execute(
        """
        CREATE TABLE IF NOT EXISTS equity_awards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company TEXT NOT NULL,
            security TEXT NOT NULL,
            award_type TEXT NOT NULL CHECK (award_type IN ('ISO', 'NSO', 'RSU')),
            grant_date TEXT NOT NULL,
            expiration_date TEXT,
            shares_granted REAL NOT NULL DEFAULT 0,
            shares_vested REAL NOT NULL DEFAULT 0,
            strike_price REAL NOT NULL DEFAULT 0,
            vesting_schedule TEXT NOT NULL DEFAULT '',
            qsbs_status TEXT NOT NULL DEFAULT 'Unknown',
            acquisition_date TEXT,
            acquisition_details TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    database.execute(
        """
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_type TEXT NOT NULL,
            transaction_date TEXT NOT NULL,
            transaction_status TEXT NOT NULL CHECK (transaction_status IN ('Historical', 'Future simulated')),
            shares REAL NOT NULL DEFAULT 0,
            fmv REAL NOT NULL DEFAULT 0,
            price REAL NOT NULL DEFAULT 0,
            fees REAL NOT NULL DEFAULT 0,
            selected_lots TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '',
            selected_lot_id INTEGER,
            regular_tax_basis REAL NOT NULL DEFAULT 0,
            amt_basis REAL NOT NULL DEFAULT 0,
            holding_period_start TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    transaction_columns = {row[1] for row in database.execute("PRAGMA table_info(transactions)")}
    for name, definition in {
        "selected_lot_id": "INTEGER",
        "regular_tax_basis": "REAL NOT NULL DEFAULT 0",
        "amt_basis": "REAL NOT NULL DEFAULT 0",
        "holding_period_start": "TEXT",
    }.items():
        if name not in transaction_columns:
            database.execute(f"ALTER TABLE transactions ADD COLUMN {name} {definition}")
    database.execute(
        """
        CREATE TABLE IF NOT EXISTS portfolio_lots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_transaction_id INTEGER NOT NULL UNIQUE,
            acquisition_type TEXT NOT NULL,
            acquisition_date TEXT NOT NULL,
            holding_period_start TEXT NOT NULL,
            shares_acquired REAL NOT NULL,
            shares_sold REAL NOT NULL DEFAULT 0,
            shares_remaining REAL NOT NULL,
            regular_tax_basis REAL NOT NULL DEFAULT 0,
            amt_basis REAL NOT NULL DEFAULT 0,
            FOREIGN KEY (source_transaction_id) REFERENCES transactions(id)
        )
        """
    )
    database.execute(
        """CREATE TABLE IF NOT EXISTS import_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_hash TEXT NOT NULL UNIQUE,
            filename TEXT NOT NULL,
            awards_imported INTEGER NOT NULL DEFAULT 0,
            transactions_imported INTEGER NOT NULL DEFAULT 0,
            imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    database.commit()
    rebuild_portfolio_lots(database)
    database.commit()


def number(value):
    """Convert a form value to a number suitable for SQLite."""
    try:
        return float(str(value or 0).replace(",", ""))
    except (TypeError, ValueError):
        raise ValueError("Numeric fields must contain valid numbers.")


def award_values(data):
    company = str(data.get("company") or "").strip()
    security = str(data.get("security") or "").strip()
    award_type = str(data.get("award_type") or "").upper()
    grant_date = str(data.get("grant_date") or "").strip()

    if not company or not security or not grant_date:
        raise ValueError("Company, security, and grant date are required.")
    if award_type not in {"ISO", "NSO", "RSU"}:
        raise ValueError("Award type must be ISO, NSO, or RSU.")

    shares_granted = number(data.get("shares_granted"))
    shares_vested = number(data.get("shares_vested"))
    strike_price = number(data.get("strike_price"))
    if min(shares_granted, shares_vested, strike_price) < 0:
        raise ValueError("Share amounts and strike price cannot be negative.")
    if shares_vested > shares_granted:
        raise ValueError("Vested shares cannot exceed granted shares.")

    return (
        company,
        security,
        award_type,
        grant_date,
        str(data.get("expiration_date") or "") or None,
        shares_granted,
        shares_vested,
        strike_price,
        str(data.get("vesting_schedule") or "").strip(),
        str(data.get("qsbs_status") or "Unknown"),
        str(data.get("acquisition_date") or "") or None,
        str(data.get("acquisition_details") or "").strip(),
    )


TRANSACTION_TYPES = {"Vesting / RSU settlement", "Option exercise", "Share sale", "Tax withholding"}
TRANSACTION_FIELDS = (
    "transaction_type", "transaction_date", "transaction_status", "shares", "fmv",
    "price", "fees", "selected_lots", "notes", "selected_lot_id",
    "regular_tax_basis", "amt_basis", "holding_period_start",
)


def transaction_values(data, allow_unlinked_sale=False):
    transaction_type = str(data.get("transaction_type") or "")
    transaction_status = str(data.get("transaction_status") or "")
    transaction_date = str(data.get("transaction_date") or "").strip()
    if transaction_type not in TRANSACTION_TYPES:
        raise ValueError("Select a valid transaction type.")
    if transaction_status not in {"Historical", "Future simulated"}:
        raise ValueError("Select historical or future simulated.")
    if not transaction_date:
        raise ValueError("Transaction date is required.")
    amounts = [number(data.get(field)) for field in ("shares", "fmv", "price", "fees", "regular_tax_basis", "amt_basis")]
    if min(amounts) < 0:
        raise ValueError("Shares, values, prices, fees, and bases cannot be negative.")
    selected_lot_id = data.get("selected_lot_id") or None
    if selected_lot_id is not None:
        selected_lot_id = int(selected_lot_id)
    if transaction_type == "Share sale" and transaction_status == "Historical" and not selected_lot_id and not allow_unlinked_sale:
        raise ValueError("A completed share sale must select an acquisition lot.")
    holding_start = str(data.get("holding_period_start") or "").strip() or transaction_date
    return (
        transaction_type, transaction_date, transaction_status, *amounts[:4],
        str(data.get("selected_lots") or "").strip(), str(data.get("notes") or "").strip(),
        selected_lot_id, amounts[4], amounts[5], holding_start,
    )


def rebuild_portfolio_lots(database):
    """Recalculate the persistent lot ledger from completed transactions."""
    database.execute("DELETE FROM portfolio_lots")
    rows = database.execute(
        "SELECT * FROM transactions WHERE transaction_status = 'Historical' ORDER BY transaction_date, id"
    ).fetchall()
    for row in rows:
        if row["transaction_type"] in {"Option exercise", "Vesting / RSU settlement"}:
            database.execute(
                """INSERT INTO portfolio_lots (
                    source_transaction_id, acquisition_type, acquisition_date, holding_period_start,
                    shares_acquired, shares_sold, shares_remaining, regular_tax_basis, amt_basis
                ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)""",
                (row["id"], row["transaction_type"], row["transaction_date"],
                 row["holding_period_start"] or row["transaction_date"], row["shares"],
                 row["shares"], row["regular_tax_basis"], row["amt_basis"]),
            )
        elif row["transaction_type"] in {"Share sale", "Tax withholding"}:
            if not row["selected_lot_id"]:
                continue
            lot = database.execute(
                "SELECT * FROM portfolio_lots WHERE source_transaction_id = ?", (row["selected_lot_id"],)
            ).fetchone()
            if lot is None:
                raise ValueError("A share sale refers to an acquisition lot that does not exist.")
            if row["shares"] > lot["shares_remaining"]:
                raise ValueError("A share sale cannot exceed the selected lot's remaining shares.")
            database.execute(
                "UPDATE portfolio_lots SET shares_sold = shares_sold + ?, shares_remaining = shares_remaining - ? WHERE id = ?",
                (row["shares"], row["shares"], lot["id"]),
            )


def csv_response(filename, fields, rows):
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(dict(row) for row in rows)
    return Response(output.getvalue(), mimetype="text/csv", headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def brokerage_number(value):
    cleaned = str(value or "0").strip().replace("$", "").replace(",", "").replace('"', "")
    if cleaned in {"", "--"}:
        return 0.0
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def brokerage_date(value):
    value = str(value or "").strip()
    if not value or value == "--":
        return ""
    for pattern in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, pattern).date().isoformat()
        except ValueError:
            continue
    return ""


def import_brokerage_portfolio(database, rows):
    """Import a brokerage gain/loss export into awards and linked ledger transactions."""
    sale_rows = [row for row in rows if str(row.get("Record Type") or "").strip().lower() == "sell"]
    if not sale_rows:
        raise ValueError("The brokerage CSV does not contain any sale records.")

    awards = {}
    for row in sale_rows:
        type_name = str(row.get("Type") or "")
        award_type = "RSU" if "Stock Unit" in type_name else ("ISO" if "Incentive" in type_name else "NSO")
        grant_number = str(row.get("Grant Number") or "").strip()
        key = grant_number or f"{row.get('Symbol')}|{award_type}|{row.get('Grant Date')}"
        entry = awards.setdefault(key, {
            "company": str(row.get("Symbol") or "Unknown").strip() or "Unknown",
            "security": "Restricted stock units" if award_type == "RSU" else "Common stock",
            "award_type": award_type,
            "grant_date": brokerage_date(row.get("Grant Date")) or brokerage_date(row.get("Date Acquired")),
            "shares": 0.0,
            "strike": brokerage_number(row.get("Grant Price")),
            "grant_number": grant_number,
        })
        entry["shares"] += brokerage_number(row.get("Quantity"))

    for award in awards.values():
        expiration = ""
        if award["award_type"] in {"ISO", "NSO"} and award["grant_date"]:
            grant = datetime.strptime(award["grant_date"], "%Y-%m-%d")
            try:
                expiration = grant.replace(year=grant.year + 10).date().isoformat()
            except ValueError:
                expiration = grant.replace(year=grant.year + 10, day=28).date().isoformat()
        database.execute(
            """INSERT INTO equity_awards (company, security, award_type, grant_date, expiration_date,
            shares_granted, shares_vested, strike_price, vesting_schedule, qsbs_status, acquisition_date,
            acquisition_details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (award["company"], award["security"], award["award_type"], award["grant_date"], expiration or None,
             award["shares"], award["shares"], award["strike"], "Imported from brokerage CSV", "Unknown", None,
             f"Grant number: {award['grant_number']}" if award["grant_number"] else "Imported from brokerage CSV"),
        )

    transaction_count = 0
    for row in sale_rows:
        type_name = str(row.get("Type") or "")
        is_rsu = "Stock Unit" in type_name
        is_iso = "Incentive" in type_name
        shares = brokerage_number(row.get("Quantity"))
        acquired = brokerage_date(row.get("Date Acquired")) or brokerage_date(row.get("Vest Date")) or brokerage_date(row.get("Exercise Date"))
        sold = brokerage_date(row.get("Date Sold"))
        if not acquired or not sold or shares <= 0:
            continue
        regular_basis = brokerage_number(row.get("Adjusted Cost Basis"))
        acquisition_fmv = brokerage_number(row.get("Vest Date FMV")) if is_rsu else brokerage_number(row.get("Exercise Date FMV"))
        if acquisition_fmv <= 0:
            acquisition_fmv = brokerage_number(row.get("Adjusted Cost Basis Per Share"))
        strike = 0 if is_rsu else brokerage_number(row.get("Grant Price"))
        amt_basis = max(regular_basis, acquisition_fmv * shares) if is_iso else regular_basis
        acquisition_type = "Vesting / RSU settlement" if is_rsu else "Option exercise"
        acquisition_values = (acquisition_type, acquired, "Historical", shares, acquisition_fmv, strike, 0,
                              str(row.get("Grant Number") or ""), "Imported acquisition", None,
                              regular_basis, amt_basis, acquired)
        placeholders = ", ".join("?" for _ in TRANSACTION_FIELDS)
        acquisition_cursor = database.execute(
            f"INSERT INTO transactions ({', '.join(TRANSACTION_FIELDS)}) VALUES ({placeholders})", acquisition_values
        )
        proceeds = brokerage_number(row.get("Total Proceeds"))
        sale_price = brokerage_number(row.get("Proceeds Per Share")) or (proceeds / shares)
        fees = max(0, sale_price * shares - proceeds)
        sale_values = ("Share sale", sold, "Historical", shares, sale_price, sale_price, fees,
                       str(row.get("Order Number") or ""), "Imported sale", acquisition_cursor.lastrowid,
                       0, 0, acquired)
        database.execute(
            f"INSERT INTO transactions ({', '.join(TRANSACTION_FIELDS)}) VALUES ({placeholders})", sale_values
        )
        transaction_count += 2

    rebuild_portfolio_lots(database)
    return len(awards), transaction_count


@app.get("/")
def home():
    return render_template("profile.html")


@app.get("/profile")
def profile():
    return render_template("profile.html")


@app.get("/awards")
def awards():
    return render_template("awards.html")


@app.get("/transactions")
def transactions():
    return render_template("transactions.html")


@app.get("/lots")
def lots():
    return render_template("lots.html")


@app.get("/imports")
def imports():
    return render_template("imports.html")


@app.get("/api/profile/<int:tax_year>")
def get_profile(tax_year):
    row = get_db().execute(
        "SELECT * FROM tax_profiles WHERE tax_year = ?", (tax_year,)
    ).fetchone()
    return jsonify(dict(row) if row else None)


@app.post("/api/profile")
def save_profile():
    data = request.get_json(silent=True) or {}
    try:
        tax_year = int(data.get("tax_year"))
        if not 1900 <= tax_year <= 2100:
            raise ValueError("Tax year is out of range.")
        values = {
            "filing_status": str(data.get("filing_status") or "Single"),
            "state": str(data.get("state") or "California"),
            "residency": str(data.get("residency") or "Full-year resident"),
            "deduction_type": (
                "itemized" if data.get("deduction_type") == "itemized" else "standard"
            ),
        }
        for field in PROFILE_FIELDS:
            if field not in values:
                values[field] = number(data.get(field))
    except (TypeError, ValueError) as error:
        return jsonify(error=str(error)), 400

    columns = ", ".join(PROFILE_FIELDS)
    placeholders = ", ".join("?" for _ in PROFILE_FIELDS)
    updates = ", ".join(f"{field} = excluded.{field}" for field in PROFILE_FIELDS)
    get_db().execute(
        f"""
        INSERT INTO tax_profiles (tax_year, {columns})
        VALUES (?, {placeholders})
        ON CONFLICT(tax_year) DO UPDATE SET
            {updates}, updated_at = CURRENT_TIMESTAMP
        """,
        [tax_year, *(values[field] for field in PROFILE_FIELDS)],
    )
    get_db().commit()
    return jsonify(message="Profile saved", tax_year=tax_year)


@app.get("/api/awards")
def get_awards():
    rows = get_db().execute(
        "SELECT * FROM equity_awards ORDER BY grant_date DESC, id DESC"
    ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.post("/api/awards")
def add_award():
    data = request.get_json(silent=True) or {}
    try:
        values = award_values(data)
    except ValueError as error:
        return jsonify(error=str(error)), 400

    cursor = get_db().execute(
        """
        INSERT INTO equity_awards (
            company, security, award_type, grant_date, expiration_date,
            shares_granted, shares_vested, strike_price, vesting_schedule,
            qsbs_status, acquisition_date, acquisition_details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        values,
    )
    get_db().commit()
    return jsonify(message="Award added", id=cursor.lastrowid), 201


@app.put("/api/awards/<int:award_id>")
def update_award(award_id):
    try:
        values = award_values(request.get_json(silent=True) or {})
    except ValueError as error:
        return jsonify(error=str(error)), 400

    cursor = get_db().execute(
        """
        UPDATE equity_awards SET
            company = ?, security = ?, award_type = ?, grant_date = ?,
            expiration_date = ?, shares_granted = ?, shares_vested = ?,
            strike_price = ?, vesting_schedule = ?, qsbs_status = ?,
            acquisition_date = ?, acquisition_details = ?
        WHERE id = ?
        """,
        (*values, award_id),
    )
    get_db().commit()
    if cursor.rowcount == 0:
        return jsonify(error="Award not found."), 404
    return jsonify(message="Award updated", id=award_id)


@app.delete("/api/awards/<int:award_id>")
def delete_award(award_id):
    cursor = get_db().execute("DELETE FROM equity_awards WHERE id = ?", (award_id,))
    get_db().commit()
    if cursor.rowcount == 0:
        return jsonify(error="Award not found."), 404
    return jsonify(message="Award deleted")


@app.get("/api/awards/export")
def export_awards():
    fields = ("id", "company", "security", "award_type", "grant_date", "expiration_date", "shares_granted", "shares_vested", "strike_price", "vesting_schedule", "qsbs_status", "acquisition_date", "acquisition_details")
    return csv_response("equity-awards.csv", fields, get_db().execute("SELECT * FROM equity_awards ORDER BY id"))


@app.post("/api/awards/import")
def import_awards():
    upload = request.files.get("file")
    if not upload:
        return jsonify(error="Choose a CSV file."), 400
    try:
        rows = list(csv.DictReader(io.StringIO(upload.read().decode("utf-8-sig"))))
        database = get_db()
        for row in rows:
            database.execute(
                """INSERT INTO equity_awards (company, security, award_type, grant_date, expiration_date,
                shares_granted, shares_vested, strike_price, vesting_schedule, qsbs_status, acquisition_date,
                acquisition_details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                award_values(row),
            )
        database.commit()
    except (UnicodeDecodeError, ValueError, sqlite3.Error) as error:
        get_db().rollback()
        return jsonify(error=f"Could not import CSV: {error}"), 400
    return jsonify(message=f"Imported {len(rows)} awards", count=len(rows))


@app.get("/api/transactions")
def get_transactions():
    rows = get_db().execute(
        "SELECT * FROM transactions ORDER BY transaction_date DESC, id DESC"
    ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.post("/api/transactions")
def add_transaction():
    try:
        values = transaction_values(request.get_json(silent=True) or {})
        database = get_db()
        placeholders = ", ".join("?" for _ in TRANSACTION_FIELDS)
        cursor = database.execute(
            f"INSERT INTO transactions ({', '.join(TRANSACTION_FIELDS)}) VALUES ({placeholders})", values
        )
        rebuild_portfolio_lots(database)
        database.commit()
    except ValueError as error:
        get_db().rollback()
        return jsonify(error=str(error)), 400
    return jsonify(message="Transaction added", id=cursor.lastrowid), 201


@app.put("/api/transactions/<int:transaction_id>")
def update_transaction(transaction_id):
    try:
        values = transaction_values(request.get_json(silent=True) or {})
        database = get_db()
        assignments = ", ".join(f"{field} = ?" for field in TRANSACTION_FIELDS)
        cursor = database.execute(f"UPDATE transactions SET {assignments} WHERE id = ?", (*values, transaction_id))
        if cursor.rowcount == 0:
            database.rollback()
            return jsonify(error="Transaction not found."), 404
        rebuild_portfolio_lots(database)
        database.commit()
    except ValueError as error:
        get_db().rollback()
        return jsonify(error=str(error)), 400
    return jsonify(message="Transaction updated", id=transaction_id)


@app.delete("/api/transactions/<int:transaction_id>")
def delete_transaction(transaction_id):
    database = get_db()
    cursor = database.execute("DELETE FROM transactions WHERE id = ?", (transaction_id,))
    if cursor.rowcount == 0:
        database.rollback()
        return jsonify(error="Transaction not found."), 404
    try:
        rebuild_portfolio_lots(database)
        database.commit()
    except ValueError as error:
        database.rollback()
        return jsonify(error=f"Delete dependent share sales first. {error}"), 409
    return jsonify(message="Transaction deleted")


@app.get("/api/lots")
def get_lots():
    rows = get_db().execute("SELECT * FROM portfolio_lots ORDER BY acquisition_date, id").fetchall()
    return jsonify([dict(row) for row in rows])


@app.get("/api/transactions/export")
def export_transactions():
    fields = ("id", *TRANSACTION_FIELDS)
    return csv_response("portfolio-transactions.csv", fields, get_db().execute("SELECT * FROM transactions ORDER BY transaction_date, id"))


@app.post("/api/transactions/import")
def import_transactions():
    upload = request.files.get("file")
    if not upload:
        return jsonify(error="Choose a CSV file."), 400
    database = get_db()
    try:
        rows = list(csv.DictReader(io.StringIO(upload.read().decode("utf-8-sig"))))
        id_map = {}
        pending = []
        for row in rows:
            old_id = str(row.get("id") or "")
            old_selected = str(row.get("selected_lot_id") or "")
            row["selected_lot_id"] = ""
            values = transaction_values(row, allow_unlinked_sale=True)
            placeholders = ", ".join("?" for _ in TRANSACTION_FIELDS)
            cursor = database.execute(f"INSERT INTO transactions ({', '.join(TRANSACTION_FIELDS)}) VALUES ({placeholders})", values)
            if old_id:
                id_map[old_id] = cursor.lastrowid
            if old_selected:
                pending.append((cursor.lastrowid, old_selected))
        for new_id, old_selected in pending:
            if old_selected not in id_map:
                raise ValueError(f"Selected lot transaction {old_selected} is missing from the CSV.")
            database.execute("UPDATE transactions SET selected_lot_id = ? WHERE id = ?", (id_map[old_selected], new_id))
        rebuild_portfolio_lots(database)
        database.commit()
    except (UnicodeDecodeError, ValueError, sqlite3.Error) as error:
        database.rollback()
        return jsonify(error=f"Could not import CSV: {error}"), 400
    return jsonify(message=f"Imported {len(rows)} transactions", count=len(rows))


@app.post("/api/portfolio/import")
def import_portfolio():
    upload = request.files.get("file")
    if not upload:
        return jsonify(error="Choose a CSV file."), 400
    contents = upload.read()
    file_hash = hashlib.sha256(contents).hexdigest()
    database = get_db()
    if database.execute("SELECT 1 FROM import_batches WHERE file_hash = ?", (file_hash,)).fetchone():
        return jsonify(error="This CSV file has already been imported."), 409
    try:
        rows = list(csv.DictReader(io.StringIO(contents.decode("utf-8-sig"))))
        if not rows or "Record Type" not in rows[0]:
            raise ValueError("This is not a supported brokerage portfolio CSV.")
        award_count, transaction_count = import_brokerage_portfolio(database, rows)
        database.execute(
            "INSERT INTO import_batches (file_hash, filename, awards_imported, transactions_imported) VALUES (?, ?, ?, ?)",
            (file_hash, upload.filename or "portfolio.csv", award_count, transaction_count),
        )
        database.commit()
    except (UnicodeDecodeError, ValueError, sqlite3.Error) as error:
        database.rollback()
        return jsonify(error=f"Could not import portfolio: {error}"), 400
    return jsonify(
        message=f"Imported {award_count} awards and {transaction_count} transactions. Lot inventory rebuilt.",
        awards=award_count,
        transactions=transaction_count,
    )


@app.get("/api/imports")
def get_imports():
    rows = get_db().execute(
        "SELECT id, filename, awards_imported, transactions_imported, imported_at FROM import_batches ORDER BY imported_at DESC, id DESC"
    ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.get("/health")
def health():
    return jsonify(status="ok")


with app.app_context():
    init_db()


if __name__ == "__main__":
    app.run(host="localhost", port=5001, debug=True)
