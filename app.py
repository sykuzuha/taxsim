import csv
import hashlib
import io
import re
import sqlite3
import zipfile
import xml.etree.ElementTree as ET
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
    database.execute(
        """
        CREATE TABLE IF NOT EXISTS exercises (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            award_id INTEGER NOT NULL,
            exercise_date TEXT NOT NULL,
            fmv REAL NOT NULL DEFAULT 0,
            shares REAL NOT NULL DEFAULT 0,
            exercise_price REAL NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (award_id) REFERENCES equity_awards(id)
        )
        """
    )
    exercise_columns = {row[1] for row in database.execute("PRAGMA table_info(exercises)")}
    if "transaction_id" not in exercise_columns:
        database.execute("ALTER TABLE exercises ADD COLUMN transaction_id INTEGER")
    award_columns = {row[1] for row in database.execute("PRAGMA table_info(equity_awards)")}
    for name, definition in {
        "grant_number": "TEXT NOT NULL DEFAULT ''",
        "notes": "TEXT NOT NULL DEFAULT ''",
        "shares_canceled": "REAL NOT NULL DEFAULT 0",
        "schedule_type": "TEXT NOT NULL DEFAULT 'custom'",
        "vesting_start": "TEXT",
        "vesting_duration_months": "INTEGER NOT NULL DEFAULT 48",
        "cliff_months": "INTEGER NOT NULL DEFAULT 0",
    }.items():
        if name not in award_columns:
            database.execute(f"ALTER TABLE equity_awards ADD COLUMN {name} {definition}")
    database.execute(
        """
        CREATE TABLE IF NOT EXISTS vesting_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            award_id INTEGER NOT NULL,
            vest_date TEXT NOT NULL,
            shares REAL NOT NULL CHECK (shares > 0),
            FOREIGN KEY (award_id) REFERENCES equity_awards(id)
        )
        """
    )
    transaction_columns = {row[1] for row in database.execute("PRAGMA table_info(transactions)")}
    for name, definition in {
        "selected_lot_id": "INTEGER",
        "regular_tax_basis": "REAL NOT NULL DEFAULT 0",
        "amt_basis": "REAL NOT NULL DEFAULT 0",
        "holding_period_start": "TEXT",
        "award_id": "INTEGER",
        "vesting_event_id": "INTEGER",
        "company": "TEXT NOT NULL DEFAULT ''",
        "security": "TEXT NOT NULL DEFAULT ''",
        "scenario_name": "TEXT NOT NULL DEFAULT ''",
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
    lot_columns = {row[1] for row in database.execute("PRAGMA table_info(portfolio_lots)")}
    for name, definition in {
        "company": "TEXT NOT NULL DEFAULT ''",
        "security": "TEXT NOT NULL DEFAULT ''",
        "source_award_id": "INTEGER",
        "fmv_at_acquisition": "REAL NOT NULL DEFAULT 0",
        "qsbs_holding_period_start": "TEXT",
    }.items():
        if name not in lot_columns:
            database.execute(f"ALTER TABLE portfolio_lots ADD COLUMN {name} {definition}")
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
    database.execute(
        """CREATE TABLE IF NOT EXISTS scenarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    scenario_columns = {row[1] for row in database.execute("PRAGMA table_info(scenarios)")}
    if "sort_order" not in scenario_columns:
        database.execute("ALTER TABLE scenarios ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
    database.execute(
        """CREATE TABLE IF NOT EXISTS scenario_lots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scenario_id INTEGER NOT NULL,
            source_lot_id INTEGER,
            lot_key TEXT NOT NULL,
            company TEXT NOT NULL DEFAULT '',
            security TEXT NOT NULL DEFAULT '',
            award_id INTEGER,
            acquisition_date TEXT NOT NULL,
            original_shares REAL NOT NULL,
            starting_shares REAL NOT NULL,
            regular_tax_basis REAL NOT NULL DEFAULT 0,
            amt_basis REAL NOT NULL DEFAULT 0
        )"""
    )
    database.execute(
        """CREATE TABLE IF NOT EXISTS scenario_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scenario_id INTEGER NOT NULL,
            transaction_type TEXT NOT NULL,
            transaction_date TEXT NOT NULL,
            shares REAL NOT NULL DEFAULT 0,
            fmv REAL NOT NULL DEFAULT 0,
            price REAL NOT NULL DEFAULT 0,
            fees REAL NOT NULL DEFAULT 0,
            award_id INTEGER,
            selected_lot_key TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT ''
        )"""
    )
    database.execute(
        """CREATE TABLE IF NOT EXISTS scenario_years (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scenario_id INTEGER NOT NULL,
            tax_year INTEGER NOT NULL,
            projected_price REAL NOT NULL DEFAULT 0,
            salary REAL NOT NULL DEFAULT 0,
            other_income REAL NOT NULL DEFAULT 0,
            deductions REAL NOT NULL DEFAULT 0,
            short_term_gains REAL NOT NULL DEFAULT 0,
            long_term_gains REAL NOT NULL DEFAULT 0,
            UNIQUE(scenario_id, tax_year)
        )"""
    )
    database.execute(
        """CREATE TABLE IF NOT EXISTS scenario_prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scenario_id INTEGER NOT NULL,
            price_date TEXT NOT NULL,
            projected_price REAL NOT NULL,
            UNIQUE(scenario_id, price_date)
        )"""
    )
    database.execute(
        """UPDATE scenarios
           SET name = 'New Scenario ' || SUBSTR(name, 14)
           WHERE name GLOB 'new scenario [0-9]*'"""
    )
    migrate_inline_vesting_schedules(database)
    link_transactions_to_awards(database)
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
    shares_canceled = number(data.get("shares_canceled"))
    schedule_type = str(data.get("schedule_type") or "custom")
    vesting_start = str(data.get("vesting_start") or "") or None
    duration_months = int(number(data.get("vesting_duration_months") or 48))
    cliff_months = int(number(data.get("cliff_months")))
    expiration_date = str(data.get("expiration_date") or "") or None
    if min(shares_granted, shares_vested, strike_price, shares_canceled) < 0:
        raise ValueError("Share amounts and strike price cannot be negative.")
    if shares_vested > shares_granted:
        raise ValueError("Vested shares cannot exceed granted shares.")
    if shares_canceled > shares_granted:
        raise ValueError("Canceled shares cannot exceed shares granted.")
    if award_type in {"ISO", "NSO"} and data.get("strike_price") in (None, ""):
        raise ValueError("Option awards require a strike price.")
    if award_type == "RSU":
        expiration_date = None
        strike_price = 0
    if schedule_type not in {"monthly", "quarterly", "annual", "cliff-monthly", "custom"}:
        raise ValueError("Select a valid vesting schedule.")
    if duration_months <= 0 or cliff_months < 0 or cliff_months > duration_months:
        raise ValueError("Vesting duration and cliff must be valid.")
    if schedule_type != "custom" and not vesting_start:
        raise ValueError("Common vesting schedules require a commencement date.")

    return (
        company,
        security,
        award_type,
        grant_date,
        expiration_date,
        shares_granted,
        shares_vested,
        strike_price,
        str(data.get("vesting_schedule") or "").strip(),
        str(data.get("qsbs_status") or "Unknown"),
        str(data.get("acquisition_date") or "") or None,
        str(data.get("acquisition_details") or "").strip(),
        str(data.get("grant_number") or "").strip(),
        str(data.get("notes") or "").strip(),
        shares_canceled,
        schedule_type,
        vesting_start,
        duration_months,
        cliff_months,
    )


def vesting_event_values(data, grant_date, shares_granted):
    raw_events = data.get("vesting_events")
    if raw_events is None:
        return None
    if not isinstance(raw_events, list):
        raise ValueError("Vesting events must be a list.")
    events = []
    for event in raw_events:
        vest_date = str(event.get("vest_date") or "").strip()
        shares = number(event.get("shares"))
        if not vest_date or shares <= 0:
            raise ValueError("Each vesting event requires a date and a positive share quantity.")
        if vest_date < grant_date:
            raise ValueError("A vesting event cannot occur before the grant date.")
        events.append((vest_date, shares))
    if sum(shares for _date, shares in events) > shares_granted:
        raise ValueError("Vesting events cannot exceed shares granted.")
    return sorted(events)


def vested_shares(database, award_id, as_of, fallback=0):
    count = database.execute(
        "SELECT COUNT(*) FROM vesting_events WHERE award_id = ?", (award_id,)
    ).fetchone()[0]
    if not count:
        return fallback
    return database.execute(
        "SELECT COALESCE(SUM(shares), 0) FROM vesting_events WHERE award_id = ? AND vest_date <= ?",
        (award_id, as_of),
    ).fetchone()[0]


def award_response(database, row, as_of):
    result = dict(row)
    events = database.execute(
        "SELECT id, vest_date, shares FROM vesting_events WHERE award_id = ? ORDER BY vest_date, id",
        (row["id"],),
    ).fetchall()
    settled_ids = {
        settled[0] for settled in database.execute(
            "SELECT vesting_event_id FROM transactions WHERE award_id = ? AND vesting_event_id IS NOT NULL",
            (row["id"],),
        )
    }
    result["vesting_events"] = [
        {**dict(event), "settled": event["id"] in settled_ids} for event in events
    ]
    result["shares_vested"] = vested_shares(database, row["id"], as_of, row["shares_vested"])
    result["shares_canceled"] = row["shares_canceled"] + database.execute(
        """SELECT COALESCE(SUM(shares),0) FROM transactions WHERE award_id = ?
           AND transaction_type = 'Award cancellation or expiration'
           AND transaction_status = 'Historical' AND transaction_date <= ?""",
        (row["id"], as_of),
    ).fetchone()[0]
    result["shares_unvested"] = max(0, row["shares_granted"] - result["shares_vested"] - result["shares_canceled"])
    result["shares_exercised"] = database.execute(
        """SELECT COALESCE(SUM(shares), 0) FROM exercises
           WHERE award_id = ? AND transaction_id IS NULL""", (row["id"],)
    ).fetchone()[0] + database.execute(
        """SELECT COALESCE(SUM(shares), 0) FROM transactions
           WHERE award_id = ? AND transaction_type = 'Option exercise' AND transaction_status = 'Historical'""",
        (row["id"],),
    ).fetchone()[0]
    result["shares_sold"] = database.execute(
        """SELECT COALESCE(SUM(shares), 0) FROM transactions
           WHERE award_id = ? AND transaction_type = 'Share sale'
           AND transaction_status = 'Historical'""",
        (row["id"],),
    ).fetchone()[0]
    result["shares_planned_for_sale"] = database.execute(
        """SELECT COALESCE(SUM(shares), 0) FROM transactions
           WHERE award_id = ? AND transaction_type = 'Share sale'
           AND transaction_status = 'Future simulated'""",
        (row["id"],),
    ).fetchone()[0]
    settled_shares = database.execute(
        "SELECT COALESCE(SUM(shares), 0) FROM transactions WHERE award_id = ? AND vesting_event_id IS NOT NULL",
        (row["id"],),
    ).fetchone()[0]
    result["shares_available"] = max(
        0, result["shares_vested"] - result["shares_exercised"] - settled_shares
    )
    return result


TRANSACTION_TYPES = {
    "Vesting / RSU settlement", "Option exercise", "Share sale", "Tax withholding",
    "Fee", "Award cancellation or expiration",
}
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
    if transaction_type != "Fee" and amounts[0] <= 0:
        raise ValueError("This transaction requires a positive number of shares.")
    if transaction_type in {"Option exercise", "Vesting / RSU settlement"} and amounts[1] <= 0:
        raise ValueError("Exercise and RSU settlement transactions require fair market value.")
    if transaction_type == "Share sale" and amounts[2] <= 0:
        raise ValueError("Share sales require a sale price per share.")
    selected_lot_id = data.get("selected_lot_id") or None
    if selected_lot_id is not None:
        selected_lot_id = int(selected_lot_id)
    if transaction_type == "Share sale" and not selected_lot_id and not allow_unlinked_sale:
        raise ValueError("A share sale must select an acquisition lot.")
    holding_start = str(data.get("holding_period_start") or "").strip() or transaction_date
    return (
        transaction_type, transaction_date, transaction_status, *amounts[:4],
        str(data.get("selected_lots") or "").strip(), str(data.get("notes") or "").strip(),
        selected_lot_id, amounts[4], amounts[5], holding_start,
    )


def transaction_associations(data, database, transaction_id=None):
    status = str(data.get("transaction_status") or "")
    transaction_type = str(data.get("transaction_type") or "")
    scenario = str(data.get("scenario_name") or "").strip()
    if status == "Future simulated" and not scenario:
        raise ValueError("Future transactions require a scenario name.")
    if status == "Historical":
        scenario = ""
    award_id = data.get("award_id") or None
    award = None
    if award_id is not None:
        award_id = int(award_id)
        award = database.execute("SELECT * FROM equity_awards WHERE id = ?", (award_id,)).fetchone()
        if award is None:
            raise ValueError("Select a valid equity award.")
    if award is None and data.get("selected_lot_id"):
        source_lot = database.execute(
            "SELECT source_award_id FROM portfolio_lots WHERE source_transaction_id = ?",
            (int(data["selected_lot_id"]),),
        ).fetchone()
        if source_lot and source_lot["source_award_id"]:
            award_id = source_lot["source_award_id"]
            award = database.execute("SELECT * FROM equity_awards WHERE id = ?", (award_id,)).fetchone()
    company = str(data.get("company") or (award["company"] if award else "")).strip()
    security = str(data.get("security") or (award["security"] if award else "")).strip()
    shares = number(data.get("shares"))
    transaction_date = str(data.get("transaction_date") or "")
    excluded = transaction_id or -1

    if not award:
        raise ValueError("Every transaction must be linked to an equity award or one of its lots.")
    if transaction_type == "Option exercise":
        if award["award_type"] not in {"ISO", "NSO"}:
            raise ValueError("Option exercises require an ISO or NSO award.")
        if not number(data.get("price")):
            data["price"] = award["strike_price"]
        if not number(data.get("regular_tax_basis")):
            data["regular_tax_basis"] = number(data.get("price")) * shares
        if not number(data.get("amt_basis")):
            data["amt_basis"] = number(data.get("fmv")) * shares if award["award_type"] == "ISO" else number(data.get("regular_tax_basis"))
        available = vested_shares(database, award_id, transaction_date, award["shares_vested"])
        available -= database.execute(
            """SELECT COALESCE(SUM(shares),0) FROM exercises
               WHERE award_id = ? AND exercise_date <= ? AND transaction_id IS NULL""",
            (award_id, transaction_date),
        ).fetchone()[0]
        query = """SELECT COALESCE(SUM(shares),0) FROM transactions
                   WHERE award_id = ? AND transaction_type = 'Option exercise' AND id != ?
                   AND transaction_date <= ?
                   AND (transaction_status = 'Historical' OR (transaction_status = 'Future simulated' AND scenario_name = ?))"""
        available -= database.execute(query, (award_id, excluded, transaction_date, scenario)).fetchone()[0]
        available -= database.execute(
            """SELECT COALESCE(SUM(shares),0) FROM transactions WHERE award_id = ?
               AND transaction_type = 'Award cancellation or expiration' AND id != ? AND transaction_date <= ?
               AND (transaction_status = 'Historical' OR (transaction_status = 'Future simulated' AND scenario_name = ?))""",
            (award_id, excluded, transaction_date, scenario),
        ).fetchone()[0]
        if shares > available:
            raise ValueError(f"Exercise exceeds available vested options ({max(0, available):g} available).")
    elif transaction_type == "Vesting / RSU settlement":
        if award["award_type"] != "RSU":
            raise ValueError("RSU settlements require an RSU award.")
        if not number(data.get("regular_tax_basis")):
            data["regular_tax_basis"] = number(data.get("fmv")) * shares
        if not number(data.get("amt_basis")):
            data["amt_basis"] = data["regular_tax_basis"]
        available = vested_shares(database, award_id, transaction_date, award["shares_vested"])
        available -= database.execute(
            """SELECT COALESCE(SUM(shares),0) FROM transactions WHERE award_id = ?
               AND transaction_type = 'Vesting / RSU settlement' AND id != ?
               AND (transaction_status = 'Historical' OR (transaction_status = 'Future simulated' AND scenario_name = ?))""",
            (award_id, excluded, scenario),
        ).fetchone()[0]
        if shares > available:
            raise ValueError(f"Settlement exceeds vested unsettled RSUs ({max(0, available):g} available).")
    elif transaction_type == "Award cancellation or expiration":
        used = database.execute(
            """SELECT COALESCE(SUM(shares),0) FROM transactions WHERE award_id = ? AND id != ?
               AND transaction_type IN ('Option exercise','Vesting / RSU settlement','Award cancellation or expiration')
               AND (transaction_status = 'Historical' OR (transaction_status = 'Future simulated' AND scenario_name = ?))""",
            (award_id, excluded, scenario),
        ).fetchone()[0]
        used += database.execute(
            "SELECT COALESCE(SUM(shares),0) FROM exercises WHERE award_id = ?", (award_id,)
        ).fetchone()[0]
        available = award["shares_granted"] - award["shares_canceled"] - used
        if shares > available:
            raise ValueError(f"Cancellation exceeds remaining award shares ({max(0, available):g} available).")
    elif transaction_type in {"Share sale", "Tax withholding"} and data.get("selected_lot_id"):
        selected_lot_id = int(data["selected_lot_id"])
        lot = database.execute(
            "SELECT * FROM portfolio_lots WHERE source_transaction_id = ?", (selected_lot_id,)
        ).fetchone()
        available = lot["shares_remaining"] if lot else 0
        if status == "Historical" and transaction_id:
            old = database.execute("SELECT * FROM transactions WHERE id = ?", (transaction_id,)).fetchone()
            if old and old["transaction_status"] == "Historical" and old["selected_lot_id"] == selected_lot_id:
                available += old["shares"]
        if status == "Future simulated":
            available -= database.execute(
                """SELECT COALESCE(SUM(shares),0) FROM transactions WHERE selected_lot_id = ? AND id != ?
                   AND transaction_status = 'Future simulated' AND scenario_name = ?
                   AND transaction_type IN ('Share sale','Tax withholding')""",
                (selected_lot_id, excluded, scenario),
            ).fetchone()[0]
        if lot is None or shares > available:
            raise ValueError("Transaction exceeds the selected lot's available shares.")
    return company, security, award_id, scenario


def rebuild_portfolio_lots(database):
    """Recalculate the persistent lot ledger from completed transactions."""
    database.execute("DELETE FROM portfolio_lots")
    rows = database.execute(
        "SELECT * FROM transactions WHERE transaction_status = 'Historical' ORDER BY transaction_date, id"
    ).fetchall()
    for row in rows:
        if row["transaction_type"] in {"Option exercise", "Vesting / RSU settlement"}:
            award = database.execute(
                "SELECT * FROM equity_awards WHERE id = ?", (row["award_id"],)
            ).fetchone() if row["award_id"] else None
            company = row["company"] or (award["company"] if award else "")
            security = row["security"] or (award["security"] if award else "")
            qsbs_start = (
                (award["acquisition_date"] or row["transaction_date"])
                if award and award["qsbs_status"] == "Eligible" else None
            )
            database.execute(
                """INSERT INTO portfolio_lots (
                    source_transaction_id, acquisition_type, acquisition_date, holding_period_start,
                    shares_acquired, shares_sold, shares_remaining, regular_tax_basis, amt_basis,
                    company, security, source_award_id, fmv_at_acquisition, qsbs_holding_period_start
                ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (row["id"], row["transaction_type"], row["transaction_date"],
                 row["holding_period_start"] or row["transaction_date"], row["shares"],
                 row["shares"], row["regular_tax_basis"], row["amt_basis"], company, security,
                 row["award_id"], row["fmv"], qsbs_start),
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
    for pattern in ("%m/%d/%Y", "%Y-%m-%d", "%d-%b-%Y"):
        try:
            return datetime.strptime(value, pattern).date().isoformat()
        except ValueError:
            continue
    return ""


def indexed_csv_rows(contents):
    """Read a CSV without losing columns when an export repeats header names."""
    parsed = list(csv.reader(io.StringIO(contents.decode("utf-8-sig"))))
    if not parsed:
        return [], []
    width = len(parsed[0])
    return parsed[0], [row + [""] * (width - len(row)) for row in parsed[1:]]


def xlsx_sheet_rows(contents):
    """Read worksheet values from an XLSX using only the Python standard library."""
    main_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    ns = {"m": main_ns, "r": rel_ns}

    def column_index(reference):
        letters = re.match(r"[A-Z]+", reference or "A").group()
        result = 0
        for letter in letters:
            result = result * 26 + ord(letter) - 64
        return result - 1

    with zipfile.ZipFile(io.BytesIO(contents)) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(node.text or "" for node in item.iter(f"{{{main_ns}}}t")) for item in root.findall("m:si", ns)]
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {
            item.get("Id"): item.get("Target").lstrip("/")
            for item in relationships.findall(f"{{{package_ns}}}Relationship")
        }
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        result = []
        for sheet in workbook.findall(".//m:sheet", ns):
            target = targets[sheet.get(f"{{{rel_ns}}}id")]
            path = target if target.startswith("xl/") else f"xl/{target}"
            root = ET.fromstring(archive.read(path))
            parsed_rows = []
            for row in root.findall(".//m:sheetData/m:row", ns):
                values = {}
                for cell in row.findall("m:c", ns):
                    value_node = cell.find("m:v", ns)
                    value = "" if value_node is None else value_node.text or ""
                    if cell.get("t") == "s" and value:
                        value = shared[int(value)]
                    elif cell.get("t") == "inlineStr":
                        value = "".join(node.text or "" for node in cell.iter(f"{{{main_ns}}}t"))
                    values[column_index(cell.get("r"))] = str(value)
                if values:
                    width = max(values) + 1
                    parsed_rows.append([values.get(index, "") for index in range(width)])
            header_index = next(
                (index for index, row in enumerate(parsed_rows) if "Record Type" in row), None
            )
            if header_index is not None:
                headers = parsed_rows[header_index]
                width = len(headers)
                rows = [(row + [""] * width)[:width] for row in parsed_rows[header_index + 1:]]
                result.append((sheet.get("name"), headers, rows))
        return result


def schedule_metadata(events):
    """Return concise schedule metadata for dated share events."""
    dates = sorted({date for date, _shares in events})
    if not dates:
        return "custom", None, 48, "No vesting events"
    parsed = [datetime.strptime(date, "%Y-%m-%d").date() for date in dates]
    gaps = [(later - earlier).days for earlier, later in zip(parsed, parsed[1:])]
    typical_gap = sorted(gaps)[len(gaps) // 2] if gaps else 0
    schedule_type = (
        "monthly" if 25 <= typical_gap <= 35 else
        "quarterly" if 80 <= typical_gap <= 100 else
        "annual" if 350 <= typical_gap <= 380 else
        "custom"
    )
    label = {"monthly": "Monthly", "quarterly": "Quarterly", "annual": "Annual", "custom": "Custom"}[schedule_type]
    duration = max(1, round((parsed[-1] - parsed[0]).days / 30.44) + (1 if schedule_type == "monthly" else 3 if schedule_type == "quarterly" else 12 if schedule_type == "annual" else 1))
    summary = f"{label} · {len(events)} events · {dates[0]} to {dates[-1]}"
    return schedule_type, dates[0], duration, summary


def migrate_inline_vesting_schedules(database):
    """Convert legacy 'date: shares, ...' descriptions into structured events."""
    pattern = re.compile(r"(\d{4}-\d{2}-\d{2}):\s*([\d,.]+)")
    rows = database.execute(
        """SELECT * FROM equity_awards
           WHERE vesting_schedule LIKE '%____-__-__:_%'
           AND NOT EXISTS (SELECT 1 FROM vesting_events WHERE award_id = equity_awards.id)"""
    ).fetchall()
    for award in rows:
        events = [(date, number(shares)) for date, shares in pattern.findall(award["vesting_schedule"])]
        events = [(date, shares) for date, shares in events if shares > 0]
        if not events:
            continue
        database.executemany(
            "INSERT INTO vesting_events (award_id, vest_date, shares) VALUES (?, ?, ?)",
            [(award["id"], date, shares) for date, shares in events],
        )
        schedule_type, start, duration, summary = schedule_metadata(events)
        database.execute(
            """UPDATE equity_awards SET vesting_schedule = ?, schedule_type = ?,
               vesting_start = ?, vesting_duration_months = ? WHERE id = ?""",
            (summary, schedule_type, start, duration, award["id"]),
        )


def link_transactions_to_awards(database):
    """Backfill award links for transactions imported before award associations existed."""
    for award in database.execute(
        "SELECT * FROM equity_awards WHERE grant_number = '' AND acquisition_details LIKE 'Grant number:%'"
    ).fetchall():
        grant_number = award["acquisition_details"].split(":", 1)[1].strip()
        if grant_number:
            database.execute("UPDATE equity_awards SET grant_number = ? WHERE id = ?", (grant_number, award["id"]))
    rows = database.execute("SELECT * FROM transactions WHERE award_id IS NULL ORDER BY id").fetchall()
    for transaction in rows:
        award = None
        grant_number = str(transaction["selected_lots"] or "").strip()
        if grant_number:
            award = database.execute(
                "SELECT * FROM equity_awards WHERE grant_number = ? ORDER BY id DESC LIMIT 1", (grant_number,)
            ).fetchone()
        if award is None and transaction["selected_lot_id"]:
            source = database.execute(
                "SELECT award_id FROM transactions WHERE id = ?", (transaction["selected_lot_id"],)
            ).fetchone()
            if source and source["award_id"]:
                award = database.execute("SELECT * FROM equity_awards WHERE id = ?", (source["award_id"],)).fetchone()
        if award:
            database.execute(
                "UPDATE transactions SET award_id = ?, company = ?, security = ? WHERE id = ?",
                (award["id"], award["company"], award["security"], transaction["id"]),
            )


def import_benefit_type_portfolio(database, headers, rows):
    """Import a By Benefit Type equity export into awards and the lot ledger."""
    positions = {}
    for index, heading in enumerate(headers):
        positions.setdefault(heading, []).append(index)

    def cell(row, heading, occurrence=0):
        indexes = positions.get(heading, [])
        return row[indexes[occurrence]].strip() if occurrence < len(indexes) else ""

    record_rows = {}
    for row in rows:
        record_rows.setdefault(cell(row, "Record Type"), []).append(row)
    grants = record_rows.get("Grant", [])
    vest_rows = record_rows.get("Vest Schedule", [])
    if not grants or not vest_rows:
        raise ValueError("The By Benefit Type CSV does not contain grant and vest schedule records.")

    tax_rows = {}
    for row in record_rows.get("Tax Withholding", []):
        tax_rows.setdefault((cell(row, "Grant Number"), cell(row, "Vest Period")), []).append(row)

    award_count = 0
    award_ids = {}
    for row in grants:
        grant_number = cell(row, "Grant Number")
        related_vests = [v for v in vest_rows if cell(v, "Grant Number") == grant_number]
        events = [
            (brokerage_date(cell(v, "Vest Date")), brokerage_number(cell(v, "Granted Qty.", 1)))
            for v in related_vests
            if brokerage_date(cell(v, "Vest Date")) and brokerage_number(cell(v, "Granted Qty.", 1)) > 0
        ]
        schedule_type, vesting_start, duration, vest_summary = schedule_metadata(events)
        cursor = database.execute(
            """INSERT INTO equity_awards (company, security, award_type, grant_date, expiration_date,
            shares_granted, shares_vested, strike_price, vesting_schedule, qsbs_status, acquisition_date,
            acquisition_details, grant_number, schedule_type, vesting_start, vesting_duration_months)
            VALUES (?, ?, 'RSU', ?, NULL, ?, ?, 0, ?, 'Unknown', NULL, ?, ?, ?, ?, ?)""",
            (
                cell(row, "Symbol") or "Unknown",
                "Performance shares" if cell(row, "Type") else "Restricted stock units",
                brokerage_date(cell(row, "Grant Date")),
                brokerage_number(cell(row, "Granted Qty.")),
                brokerage_number(cell(row, "Vested Qty.")),
                vest_summary,
                "Imported from By Benefit Type CSV",
                grant_number,
                schedule_type,
                vesting_start,
                duration,
            ),
        )
        database.executemany(
            "INSERT INTO vesting_events (award_id, vest_date, shares) VALUES (?, ?, ?)",
            [(cursor.lastrowid, date, shares) for date, shares in events],
        )
        award_ids[grant_number] = cursor.lastrowid
        award_count += 1

    transaction_count = 0
    placeholders = ", ".join("?" for _ in TRANSACTION_FIELDS)
    today = datetime.now().date()
    for row in vest_rows:
        vest_date = brokerage_date(cell(row, "Vest Date"))
        if not vest_date:
            continue
        is_future = datetime.strptime(vest_date, "%Y-%m-%d").date() > today
        released = (
            brokerage_number(cell(row, "Released Qty"))
            or brokerage_number(cell(row, "Vested Qty.", 1))
            or (brokerage_number(cell(row, "Granted Qty.", 1)) if is_future else 0)
        )
        if released <= 0:
            continue
        status = "Future simulated" if is_future else "Historical"
        taxes = tax_rows.get((cell(row, "Grant Number"), cell(row, "Vest Period")), [])
        taxable_gain = next((brokerage_number(cell(t, "Taxable Gain")) for t in taxes if brokerage_number(cell(t, "Taxable Gain"))), 0)
        fmv = taxable_gain / released if released else 0
        basis = taxable_gain or brokerage_number(cell(row, "Released Amount"))
        acquisition = (
            "Vesting / RSU settlement", vest_date, status, released, fmv, 0, 0,
            cell(row, "Grant Number"), f"Imported vest period {cell(row, 'Vest Period')}",
            None, basis, basis, vest_date,
        )
        grant_number = cell(row, "Grant Number")
        award_id = award_ids.get(grant_number)
        cursor = database.execute(
            f"""INSERT INTO transactions ({', '.join(TRANSACTION_FIELDS)}, company, security, award_id)
                VALUES ({placeholders}, ?, ?, ?)""",
            (*acquisition, cell(row, "Symbol") or "", "Performance shares", award_id),
        )
        transaction_count += 1

        withheld_shares = brokerage_number(cell(row, "Shares Traded for taxes"))
        if withheld_shares > 0:
            withheld_amount = sum(brokerage_number(cell(t, "Withholding Amount")) for t in taxes)
            tax_detail = ", ".join(
                f"{cell(t, 'Tax Description')}: {cell(t, 'Withholding Amount')}"
                for t in taxes if cell(t, "Tax Description")
            )
            withholding = (
                "Tax withholding", vest_date, status, withheld_shares, fmv, fmv, withheld_amount,
                cell(row, "Grant Number"), tax_detail or "Imported tax withholding",
                cursor.lastrowid, 0, 0, vest_date,
            )
            database.execute(
                f"""INSERT INTO transactions ({', '.join(TRANSACTION_FIELDS)}, company, security, award_id)
                    VALUES ({placeholders}, ?, ?, ?)""",
                (*withholding, cell(row, "Symbol") or "", "Performance shares", award_id),
            )
            transaction_count += 1

    rebuild_portfolio_lots(database)
    return award_count, transaction_count


def import_option_benefit_type(database, headers, rows):
    """Import the Options worksheet from a By Benefit Type workbook."""
    positions = {heading: index for index, heading in enumerate(headers)}

    def cell(row, heading):
        index = positions.get(heading)
        return row[index].strip() if index is not None and index < len(row) else ""

    grants = [row for row in rows if cell(row, "Record Type") == "Grant"]
    vest_rows = [row for row in rows if cell(row, "Record Type") == "Vest Schedule"]
    if not grants:
        raise ValueError("The options worksheet does not contain grant records.")
    count = 0
    for grant in grants:
        grant_number = cell(grant, "Grant Number")
        related = [row for row in vest_rows if cell(row, "Grant Number") == grant_number]
        events = [
            (brokerage_date(cell(row, "Vest Date")), brokerage_number(cell(row, "Vesting Qty.")))
            for row in related
            if brokerage_date(cell(row, "Vest Date")) and brokerage_number(cell(row, "Vesting Qty.")) > 0
        ]
        schedule_type, vesting_start, duration, summary = schedule_metadata(events)
        type_name = cell(grant, "Type").upper()
        award_type = "ISO" if type_name == "ISO" else "NSO"
        expiration = next((brokerage_date(cell(row, "Expiration Date")) for row in related if brokerage_date(cell(row, "Expiration Date"))), None)
        cursor = database.execute(
            """INSERT INTO equity_awards (
                company, security, award_type, grant_date, expiration_date, shares_granted,
                shares_vested, strike_price, vesting_schedule, grant_number, schedule_type,
                vesting_start, vesting_duration_months, acquisition_details
            ) VALUES (?, 'Common stock', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (cell(grant, "Symbol") or "Unknown", award_type, brokerage_date(cell(grant, "Grant Date")),
             expiration, brokerage_number(cell(grant, "Granted Qty.")),
             brokerage_number(cell(grant, "Vested Qty.")), brokerage_number(cell(grant, "Exercise Price")),
             summary, grant_number, schedule_type, vesting_start, duration,
             "Imported from By Benefit Type XLSX"),
        )
        database.executemany(
            "INSERT INTO vesting_events (award_id, vest_date, shares) VALUES (?, ?, ?)",
            [(cursor.lastrowid, date, shares) for date, shares in events],
        )
        count += 1
    return count, 0


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

    for key, award in awards.items():
        expiration = ""
        if award["award_type"] in {"ISO", "NSO"} and award["grant_date"]:
            grant = datetime.strptime(award["grant_date"], "%Y-%m-%d")
            try:
                expiration = grant.replace(year=grant.year + 10).date().isoformat()
            except ValueError:
                expiration = grant.replace(year=grant.year + 10, day=28).date().isoformat()
        cursor = database.execute(
            """INSERT INTO equity_awards (company, security, award_type, grant_date, expiration_date,
            shares_granted, shares_vested, strike_price, vesting_schedule, qsbs_status, acquisition_date,
            acquisition_details, grant_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (award["company"], award["security"], award["award_type"], award["grant_date"], expiration or None,
             award["shares"], award["shares"], award["strike"], "Imported from brokerage CSV", "Unknown", None,
             "Imported from brokerage CSV", award["grant_number"]),
        )
        award["id"] = cursor.lastrowid

    transaction_count = 0
    for row in sale_rows:
        type_name = str(row.get("Type") or "")
        is_rsu = "Stock Unit" in type_name
        is_iso = "Incentive" in type_name
        shares = brokerage_number(row.get("Quantity"))
        grant_number = str(row.get("Grant Number") or "").strip()
        award_key = grant_number or f"{row.get('Symbol')}|{('RSU' if is_rsu else 'ISO' if is_iso else 'NSO')}|{row.get('Grant Date')}"
        award = awards[award_key]
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
            f"""INSERT INTO transactions ({', '.join(TRANSACTION_FIELDS)}, company, security, award_id)
                VALUES ({placeholders}, ?, ?, ?)""",
            (*acquisition_values, award["company"], award["security"], award["id"]),
        )
        proceeds = brokerage_number(row.get("Total Proceeds"))
        sale_price = brokerage_number(row.get("Proceeds Per Share")) or (proceeds / shares)
        fees = max(0, sale_price * shares - proceeds)
        sale_values = ("Share sale", sold, "Historical", shares, sale_price, sale_price, fees,
                       str(row.get("Order Number") or ""), "Imported sale", acquisition_cursor.lastrowid,
                       0, 0, acquired)
        database.execute(
            f"""INSERT INTO transactions ({', '.join(TRANSACTION_FIELDS)}, company, security, award_id)
                VALUES ({placeholders}, ?, ?, ?)""",
            (*sale_values, award["company"], award["security"], award["id"]),
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


@app.get("/exercises")
def exercises():
    return render_template("exercises.html")


@app.get("/lots")
def lots():
    return render_template("lots.html")


@app.get("/imports")
def imports():
    return render_template("imports.html")


@app.get("/scenarios")
def scenarios():
    return render_template("scenarios.html")


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
    database = get_db()
    as_of = request.args.get("as_of") or datetime.now().date().isoformat()
    rows = database.execute(
        "SELECT * FROM equity_awards ORDER BY grant_date DESC, id DESC"
    ).fetchall()
    return jsonify([award_response(database, row, as_of) for row in rows])


@app.post("/api/awards")
def add_award():
    data = request.get_json(silent=True) or {}
    database = get_db()
    try:
        values = award_values(data)
        events = vesting_event_values(data, values[3], values[5])
    except ValueError as error:
        return jsonify(error=str(error)), 400

    try:
        cursor = database.execute(
            """
            INSERT INTO equity_awards (
                company, security, award_type, grant_date, expiration_date,
                shares_granted, shares_vested, strike_price, vesting_schedule,
                qsbs_status, acquisition_date, acquisition_details, grant_number, notes, shares_canceled,
                schedule_type, vesting_start, vesting_duration_months, cliff_months
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            values,
        )
        for vest_date, shares in events or []:
            database.execute(
                "INSERT INTO vesting_events (award_id, vest_date, shares) VALUES (?, ?, ?)",
                (cursor.lastrowid, vest_date, shares),
            )
        database.commit()
    except sqlite3.Error:
        database.rollback()
        raise
    return jsonify(message="Award added", id=cursor.lastrowid), 201


@app.put("/api/awards/<int:award_id>")
def update_award(award_id):
    data = request.get_json(silent=True) or {}
    database = get_db()
    try:
        values = award_values(data)
        events = vesting_event_values(data, values[3], values[5])
        existing = database.execute("SELECT * FROM equity_awards WHERE id = ?", (award_id,)).fetchone()
        if existing is None:
            return jsonify(error="Award not found."), 404
        exercises = database.execute(
            "SELECT exercise_date, shares FROM exercises WHERE award_id = ? ORDER BY exercise_date", (award_id,)
        ).fetchall()
        current_events = [
            (row["vest_date"], row["shares"]) for row in database.execute(
                "SELECT vest_date, shares FROM vesting_events WHERE award_id = ? ORDER BY vest_date, id", (award_id,)
            )
        ]
        events_changed = events is not None and events != current_events
        settled_shares = database.execute(
            "SELECT COALESCE(SUM(shares), 0) FROM transactions WHERE award_id = ? AND vesting_event_id IS NOT NULL",
            (award_id,),
        ).fetchone()[0]
        if settled_shares and values[2] != "RSU":
            raise ValueError("An award with completed RSU settlements must remain an RSU.")
        if settled_shares + values[14] > values[5]:
            raise ValueError("Shares granted cannot be less than settled and canceled shares.")
        if events_changed and settled_shares:
            raise ValueError("Vesting events with completed RSU settlements cannot be changed.")
        if exercises and values[2] == "RSU":
            raise ValueError("An award with completed exercises cannot be changed to an RSU.")
        if exercises and values[3] > exercises[0]["exercise_date"]:
            raise ValueError("Grant date cannot be later than an existing exercise.")
        if sum(row["shares"] for row in exercises) + values[14] > values[5]:
            raise ValueError("Shares granted cannot be less than shares already exercised.")
        if events is not None:
            for exercise in exercises:
                available = sum(shares for vest_date, shares in events if vest_date <= exercise["exercise_date"])
                exercised_through_date = sum(
                    row["shares"] for row in exercises if row["exercise_date"] <= exercise["exercise_date"]
                )
                if exercised_through_date > available:
                    raise ValueError("The new vesting schedule would invalidate an existing exercise.")
    except ValueError as error:
        return jsonify(error=str(error)), 400

    database.execute(
        """
        UPDATE equity_awards SET
            company = ?, security = ?, award_type = ?, grant_date = ?,
            expiration_date = ?, shares_granted = ?, shares_vested = ?,
            strike_price = ?, vesting_schedule = ?, qsbs_status = ?,
            acquisition_date = ?, acquisition_details = ?, grant_number = ?, notes = ?,
            shares_canceled = ?, schedule_type = ?, vesting_start = ?,
            vesting_duration_months = ?, cliff_months = ?
        WHERE id = ?
        """,
        (*values, award_id),
    )
    if events_changed:
        database.execute("DELETE FROM vesting_events WHERE award_id = ?", (award_id,))
        database.executemany(
            "INSERT INTO vesting_events (award_id, vest_date, shares) VALUES (?, ?, ?)",
            [(award_id, vest_date, shares) for vest_date, shares in events],
        )
        database.execute(
            "UPDATE equity_awards SET shares_vested = ? WHERE id = ?",
            (sum(shares for vest_date, shares in events if vest_date <= datetime.now().date().isoformat()), award_id),
        )
    database.commit()
    return jsonify(message="Award updated", id=award_id)


@app.delete("/api/awards/<int:award_id>")
def delete_award(award_id):
    if get_db().execute("SELECT 1 FROM exercises WHERE award_id = ?", (award_id,)).fetchone():
        return jsonify(error="Delete this award's exercises first."), 409
    if get_db().execute("SELECT 1 FROM transactions WHERE award_id = ?", (award_id,)).fetchone():
        return jsonify(error="Delete this award's completed settlement transactions first."), 409
    database = get_db()
    database.execute("DELETE FROM vesting_events WHERE award_id = ?", (award_id,))
    cursor = database.execute("DELETE FROM equity_awards WHERE id = ?", (award_id,))
    database.commit()
    if cursor.rowcount == 0:
        return jsonify(error="Award not found."), 404
    return jsonify(message="Award deleted")


@app.get("/api/awards/export")
def export_awards():
    fields = ("id", "company", "security", "award_type", "grant_date", "expiration_date", "shares_granted", "shares_vested", "shares_canceled", "strike_price", "vesting_schedule", "schedule_type", "vesting_start", "vesting_duration_months", "cliff_months", "qsbs_status", "acquisition_date", "acquisition_details", "grant_number", "notes")
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
                acquisition_details, grant_number, notes, shares_canceled, schedule_type, vesting_start,
                vesting_duration_months, cliff_months) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                award_values(row),
            )
        database.commit()
    except (UnicodeDecodeError, ValueError, sqlite3.Error) as error:
        get_db().rollback()
        return jsonify(error=f"Could not import CSV: {error}"), 400
    return jsonify(message=f"Imported {len(rows)} awards", count=len(rows))


@app.get("/api/exercises")
def get_exercises():
    rows = get_db().execute(
        """SELECT exercises.*, equity_awards.company, equity_awards.security,
                  equity_awards.award_type, equity_awards.grant_date
           FROM exercises
           JOIN equity_awards ON equity_awards.id = exercises.award_id
           ORDER BY exercise_date DESC, exercises.id DESC"""
    ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.post("/api/exercises")
def add_exercise():
    data = request.get_json(silent=True) or {}
    database = get_db()
    try:
        award_id = int(data.get("award_id"))
        exercise_date = str(data.get("exercise_date") or "").strip()
        fmv = number(data.get("fmv"))
        shares = number(data.get("shares"))
        exercise_price = number(data.get("exercise_price"))
        if not exercise_date:
            raise ValueError("Exercise date is required.")
        if min(fmv, shares, exercise_price) < 0:
            raise ValueError("FMV, shares, and exercise price cannot be negative.")
        if shares <= 0:
            raise ValueError("Number of shares must be greater than zero.")
        award = database.execute("SELECT * FROM equity_awards WHERE id = ?", (award_id,)).fetchone()
        if award is None:
            raise ValueError("Select a valid equity award.")
        if award["award_type"] not in {"ISO", "NSO"}:
            raise ValueError("Only option awards can be exercised.")
        if exercise_date < award["grant_date"]:
            raise ValueError("Exercise date cannot be before the grant date.")
        if award["expiration_date"] and exercise_date > award["expiration_date"]:
            raise ValueError("Exercise date cannot be after the option expiration date.")
        available = vested_shares(database, award_id, exercise_date, award["shares_vested"])
        previously_exercised = database.execute(
            """SELECT COALESCE(SUM(shares), 0) FROM exercises
               WHERE award_id = ? AND exercise_date <= ? AND transaction_id IS NULL""",
            (award_id, exercise_date),
        ).fetchone()[0] + database.execute(
            """SELECT COALESCE(SUM(shares), 0) FROM transactions WHERE award_id = ?
               AND transaction_type = 'Option exercise' AND transaction_status = 'Historical'
               AND transaction_date <= ?""", (award_id, exercise_date)
        ).fetchone()[0]
        if previously_exercised + shares > available:
            remaining = max(0, available - previously_exercised)
            raise ValueError(f"Exercise exceeds vested and unexercised options ({remaining:g} available).")
        later_exercises = database.execute(
            "SELECT exercise_date, shares FROM exercises WHERE award_id = ? AND exercise_date > ? ORDER BY exercise_date",
            (award_id, exercise_date),
        ).fetchall()
        cumulative = previously_exercised + shares
        for later in later_exercises:
            cumulative += later["shares"]
            later_available = vested_shares(get_db(), award_id, later["exercise_date"], award["shares_vested"])
            if cumulative > later_available:
                raise ValueError("This exercise would invalidate a later completed exercise.")
    except (TypeError, ValueError) as error:
        return jsonify(error=str(error)), 400

    try:
        regular_basis = exercise_price * shares
        amt_basis = fmv * shares if award["award_type"] == "ISO" else regular_basis
        transaction_values_ = (
            "Option exercise", exercise_date, "Historical", shares, fmv, exercise_price, 0,
            f"Award #{award_id}", "Created from Exercises page", None,
            regular_basis, amt_basis, exercise_date,
        )
        placeholders = ", ".join("?" for _ in TRANSACTION_FIELDS)
        transaction_cursor = database.execute(
            f"""INSERT INTO transactions ({', '.join(TRANSACTION_FIELDS)}, company, security, award_id)
                VALUES ({placeholders}, ?, ?, ?)""",
            (*transaction_values_, award["company"], award["security"], award_id),
        )
        cursor = database.execute(
            """INSERT INTO exercises (award_id, exercise_date, fmv, shares, exercise_price, transaction_id)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (award_id, exercise_date, fmv, shares, exercise_price, transaction_cursor.lastrowid),
        )
        rebuild_portfolio_lots(database)
        database.commit()
    except (ValueError, sqlite3.Error) as error:
        database.rollback()
        return jsonify(error=str(error)), 400
    return jsonify(message="Exercise saved and acquisition lot created", id=cursor.lastrowid), 201


@app.delete("/api/exercises/<int:exercise_id>")
def delete_exercise(exercise_id):
    database = get_db()
    exercise = database.execute("SELECT * FROM exercises WHERE id = ?", (exercise_id,)).fetchone()
    if exercise is None:
        return jsonify(error="Exercise not found."), 404
    cursor = database.execute("DELETE FROM exercises WHERE id = ?", (exercise_id,))
    if exercise["transaction_id"]:
        database.execute("DELETE FROM transactions WHERE id = ?", (exercise["transaction_id"],))
    try:
        rebuild_portfolio_lots(database)
        database.commit()
    except ValueError as error:
        database.rollback()
        return jsonify(error=f"Delete dependent share sales first. {error}"), 409
    return jsonify(message="Exercise deleted")


@app.post("/api/vesting-events/<int:event_id>/settle")
def settle_vesting_event(event_id):
    data = request.get_json(silent=True) or {}
    database = get_db()
    try:
        fmv = number(data.get("fmv"))
        if fmv < 0:
            raise ValueError("FMV cannot be negative.")
        row = database.execute(
            """SELECT vesting_events.*, equity_awards.company, equity_awards.award_type
               FROM vesting_events JOIN equity_awards ON equity_awards.id = vesting_events.award_id
               WHERE vesting_events.id = ?""",
            (event_id,),
        ).fetchone()
        if row is None:
            return jsonify(error="Vesting event not found."), 404
        if row["award_type"] != "RSU":
            raise ValueError("Only RSU vesting events can create settlement lots.")
        if row["vest_date"] > datetime.now().date().isoformat():
            raise ValueError("A future vesting event cannot be settled.")
        if database.execute(
            "SELECT 1 FROM transactions WHERE vesting_event_id = ?", (event_id,)
        ).fetchone():
            return jsonify(error="This vesting event has already been settled."), 409
        basis = fmv * row["shares"]
        values = (
            "Vesting / RSU settlement", row["vest_date"], "Historical", row["shares"], fmv, 0, 0,
            f"Award #{row['award_id']}", f"RSU settlement for {row['company']}", None,
            basis, basis, row["vest_date"],
        )
        placeholders = ", ".join("?" for _ in TRANSACTION_FIELDS)
        cursor = database.execute(
            f"""INSERT INTO transactions ({', '.join(TRANSACTION_FIELDS)}, award_id, vesting_event_id)
                VALUES ({placeholders}, ?, ?)""",
            (*values, row["award_id"], event_id),
        )
        rebuild_portfolio_lots(database)
        database.commit()
    except (ValueError, sqlite3.Error) as error:
        database.rollback()
        return jsonify(error=str(error)), 400
    return jsonify(message="RSU settlement and acquisition lot created", transaction_id=cursor.lastrowid), 201


@app.get("/api/transactions")
def get_transactions():
    rows = get_db().execute(
        """SELECT transactions.*,
                  COALESCE(NULLIF(transactions.company, ''), equity_awards.company, '') AS display_company,
                  COALESCE(NULLIF(transactions.security, ''), equity_awards.security, '') AS display_security,
                  equity_awards.award_type, equity_awards.grant_number
           FROM transactions LEFT JOIN equity_awards ON equity_awards.id = transactions.award_id
           ORDER BY transaction_date DESC, transactions.id DESC"""
    ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.post("/api/transactions")
def add_transaction():
    database = get_db()
    try:
        data = request.get_json(silent=True) or {}
        associations = transaction_associations(data, database)
        values = transaction_values(data)
        placeholders = ", ".join("?" for _ in TRANSACTION_FIELDS)
        cursor = database.execute(
            f"""INSERT INTO transactions ({', '.join(TRANSACTION_FIELDS)}, company, security, award_id, scenario_name)
                VALUES ({placeholders}, ?, ?, ?, ?)""", (*values, *associations)
        )
        rebuild_portfolio_lots(database)
        database.commit()
    except ValueError as error:
        get_db().rollback()
        return jsonify(error=str(error)), 400
    return jsonify(message="Transaction added", id=cursor.lastrowid), 201


@app.put("/api/transactions/<int:transaction_id>")
def update_transaction(transaction_id):
    database = get_db()
    try:
        data = request.get_json(silent=True) or {}
        associations = transaction_associations(data, database, transaction_id)
        values = transaction_values(data)
        assignments = ", ".join(f"{field} = ?" for field in TRANSACTION_FIELDS)
        cursor = database.execute(
            f"""UPDATE transactions SET {assignments}, company = ?, security = ?, award_id = ?, scenario_name = ?
                WHERE id = ?""", (*values, *associations, transaction_id)
        )
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
    database = get_db()
    rows = database.execute(
        """SELECT portfolio_lots.*, equity_awards.grant_number, equity_awards.award_type
           FROM portfolio_lots
           LEFT JOIN equity_awards ON equity_awards.id = portfolio_lots.source_award_id
           ORDER BY acquisition_date, portfolio_lots.id"""
    ).fetchall()
    lots = []
    for row in rows:
        lot = dict(row)
        shares = lot["shares_acquired"]
        lot["regular_tax_basis_per_share"] = lot["regular_tax_basis"] / shares if shares else 0
        lot["amt_basis_per_share"] = lot["amt_basis"] / shares if shares else 0
        lot["status"] = "Fully sold" if lot["shares_remaining"] <= 0 else "Open"
        history = database.execute(
            """SELECT id, transaction_type, transaction_date, transaction_status, shares,
                      fmv, price, fees, notes
               FROM transactions
               WHERE id = ? OR selected_lot_id = ?
               ORDER BY transaction_date, id""",
            (lot["source_transaction_id"], lot["source_transaction_id"]),
        ).fetchall()
        lot["transaction_history"] = [dict(item) for item in history]
        lots.append(lot)
    return jsonify(lots)


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
        return jsonify(error="Choose a CSV or XLSX file."), 400
    contents = upload.read()
    file_hash = hashlib.sha256(contents).hexdigest()
    database = get_db()
    if database.execute("SELECT 1 FROM import_batches WHERE file_hash = ?", (file_hash,)).fetchone():
        return jsonify(error="This file has already been imported."), 409
    try:
        is_xlsx = (upload.filename or "").lower().endswith(".xlsx") or contents.startswith(b"PK")
        sheets = xlsx_sheet_rows(contents) if is_xlsx else [("CSV", *indexed_csv_rows(contents))]
        award_count = transaction_count = supported_sheets = 0
        for _sheet_name, headers, raw_rows in sheets:
            if not raw_rows or "Record Type" not in headers:
                continue
            record_types = {row[headers.index("Record Type")].strip() for row in raw_rows}
            if "Grant" in record_types and "Vest Schedule" in record_types:
                if "Exercise Price" in headers:
                    awards_added, transactions_added = import_option_benefit_type(database, headers, raw_rows)
                else:
                    awards_added, transactions_added = import_benefit_type_portfolio(database, headers, raw_rows)
            elif any(record_type.lower() == "sell" for record_type in record_types):
                rows = [dict(zip(headers, row)) for row in raw_rows]
                awards_added, transactions_added = import_brokerage_portfolio(database, rows)
            else:
                continue
            award_count += awards_added
            transaction_count += transactions_added
            supported_sheets += 1
        if not supported_sheets:
            raise ValueError("No supported By Benefit Type or gain/loss worksheet was found.")
        database.execute(
            "INSERT INTO import_batches (file_hash, filename, awards_imported, transactions_imported) VALUES (?, ?, ?, ?)",
            (file_hash, upload.filename or "portfolio.csv", award_count, transaction_count),
        )
        database.commit()
    except (UnicodeDecodeError, ValueError, sqlite3.Error, zipfile.BadZipFile, ET.ParseError, KeyError) as error:
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


SCENARIO_TYPES = {"Option exercise", "Vesting / RSU settlement", "Share sale", "Tax withholding"}
SCENARIO_ORDER = {
    "Vesting / RSU settlement": 1,
    "Option exercise": 2,
    "Tax withholding": 3,
    "Share sale": 4,
}


def snapshot_scenario_lots(database, scenario_id):
    rows = database.execute("SELECT * FROM portfolio_lots ORDER BY id").fetchall()
    for lot in rows:
        database.execute(
            """INSERT INTO scenario_lots (
                scenario_id, source_lot_id, lot_key, company, security, award_id,
                acquisition_date, original_shares, starting_shares, regular_tax_basis, amt_basis
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (scenario_id, lot["id"], f"h:{lot['id']}", lot["company"], lot["security"],
             lot["source_award_id"], lot["acquisition_date"], lot["shares_acquired"],
             lot["shares_remaining"], lot["regular_tax_basis"], lot["amt_basis"]),
        )


def calculate_scenario(database, scenario_id):
    base_lots = database.execute(
        "SELECT * FROM scenario_lots WHERE scenario_id = ? ORDER BY acquisition_date, id", (scenario_id,)
    ).fetchall()
    lots = {
        row["lot_key"]: {**dict(row), "shares_remaining": row["starting_shares"], "simulated": False}
        for row in base_lots
    }
    rows = database.execute(
        "SELECT * FROM scenario_transactions WHERE scenario_id = ?", (scenario_id,)
    ).fetchall()
    transactions = sorted(
        (dict(row) for row in rows),
        key=lambda row: (row["transaction_date"], SCENARIO_ORDER.get(row["transaction_type"], 99), row["id"]),
    )
    award_usage = {}
    errors = []
    for transaction in transactions:
        error = ""
        shares = transaction["shares"]
        if shares <= 0:
            error = "Shares must be greater than zero."
        elif transaction["transaction_type"] in {"Option exercise", "Vesting / RSU settlement"}:
            award = database.execute(
                "SELECT * FROM equity_awards WHERE id = ?", (transaction["award_id"],)
            ).fetchone() if transaction["award_id"] else None
            expected = {"Option exercise": {"ISO", "NSO"}, "Vesting / RSU settlement": {"RSU"}}[transaction["transaction_type"]]
            if not award or award["award_type"] not in expected:
                error = "Select an appropriate source award."
            else:
                historically_used = database.execute(
                    """SELECT COALESCE(SUM(shares),0) FROM transactions WHERE award_id = ?
                       AND transaction_status = 'Historical' AND transaction_type = ?""",
                    (award["id"], transaction["transaction_type"]),
                ).fetchone()[0]
                if transaction["transaction_type"] == "Option exercise":
                    historically_used += database.execute(
                        "SELECT COALESCE(SUM(shares),0) FROM exercises WHERE award_id = ? AND transaction_id IS NULL",
                        (award["id"],),
                    ).fetchone()[0]
                available = vested_shares(
                    database, award["id"], transaction["transaction_date"], award["shares_vested"]
                ) - historically_used - award_usage.get((award["id"], transaction["transaction_type"]), 0)
                if shares > available:
                    error = f"Only {max(0, available):g} vested shares are available."
                else:
                    award_usage[(award["id"], transaction["transaction_type"])] = (
                        award_usage.get((award["id"], transaction["transaction_type"]), 0) + shares
                    )
                    regular_basis = (transaction["price"] * shares if transaction["transaction_type"] == "Option exercise" else transaction["fmv"] * shares)
                    amt_basis = transaction["fmv"] * shares if award["award_type"] == "ISO" else regular_basis
                    lots[f"t:{transaction['id']}"] = {
                        "lot_key": f"t:{transaction['id']}", "company": award["company"],
                        "security": award["security"], "award_id": award["id"],
                        "acquisition_date": transaction["transaction_date"], "original_shares": shares,
                        "starting_shares": shares, "shares_remaining": shares,
                        "regular_tax_basis": regular_basis, "amt_basis": amt_basis, "simulated": True,
                    }
        else:
            lot = lots.get(transaction["selected_lot_key"])
            if not lot:
                error = "Select a lot available at this point in the timeline."
            elif transaction["transaction_date"] < lot["acquisition_date"]:
                error = "A lot cannot be used before its acquisition date."
            elif shares > lot["shares_remaining"]:
                error = f"Only {lot['shares_remaining']:g} shares remain in the selected lot."
            else:
                lot["shares_remaining"] -= shares
        transaction["error"] = error
        transaction["valid"] = not error
        if error:
            errors.append({"transaction_id": transaction["id"], "message": error})
    years = [dict(row) for row in database.execute(
        "SELECT * FROM scenario_years WHERE scenario_id = ? ORDER BY tax_year", (scenario_id,)
    )]
    prices = [dict(row) for row in database.execute(
        "SELECT * FROM scenario_prices WHERE scenario_id = ? ORDER BY price_date", (scenario_id,)
    )]
    return {
        "transactions": transactions, "lots": list(lots.values()), "errors": errors,
        "years": years, "prices": prices,
        "summary": {
            "transactions": len(transactions), "invalid": len(errors),
            "shares_remaining": sum(lot["shares_remaining"] for lot in lots.values()),
            "projected_income": sum(year["salary"] + year["other_income"] for year in years),
        },
    }


@app.get("/api/scenarios")
def get_scenarios():
    database = get_db()
    result = []
    for row in database.execute("SELECT * FROM scenarios ORDER BY sort_order, id"):
        result.append({**dict(row), **calculate_scenario(database, row["id"])["summary"]})
    return jsonify(result)


@app.post("/api/scenarios")
def add_scenario():
    name = str((request.get_json(silent=True) or {}).get("name") or "").strip()
    if not name:
        existing_names = {
            row[0].lower() for row in get_db().execute("SELECT name FROM scenarios")
        }
        number_suffix = 1
        while f"new scenario {number_suffix}" in existing_names:
            number_suffix += 1
        name = f"New Scenario {number_suffix}"
    database = get_db()
    next_order = database.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM scenarios").fetchone()[0]
    cursor = database.execute("INSERT INTO scenarios (name, sort_order) VALUES (?, ?)", (name, next_order))
    snapshot_scenario_lots(database, cursor.lastrowid)
    database.commit()
    return jsonify(message="Scenario created", id=cursor.lastrowid), 201


@app.get("/api/scenarios/<int:scenario_id>")
def get_scenario(scenario_id):
    database = get_db()
    row = database.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
    if row is None:
        return jsonify(error="Scenario not found."), 404
    return jsonify({**dict(row), **calculate_scenario(database, scenario_id)})


@app.put("/api/scenarios/<int:scenario_id>")
def rename_scenario(scenario_id):
    name = str((request.get_json(silent=True) or {}).get("name") or "").strip()
    if not name:
        return jsonify(error="Scenario name is required."), 400
    cursor = get_db().execute(
        "UPDATE scenarios SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (name, scenario_id)
    )
    get_db().commit()
    return (jsonify(message="Scenario renamed") if cursor.rowcount else (jsonify(error="Scenario not found."), 404))


@app.delete("/api/scenarios/<int:scenario_id>")
def delete_scenario(scenario_id):
    database = get_db()
    for table in ("scenario_transactions", "scenario_lots", "scenario_years", "scenario_prices"):
        database.execute(f"DELETE FROM {table} WHERE scenario_id = ?", (scenario_id,))
    cursor = database.execute("DELETE FROM scenarios WHERE id = ?", (scenario_id,))
    database.commit()
    return (jsonify(message="Scenario deleted") if cursor.rowcount else (jsonify(error="Scenario not found."), 404))


@app.post("/api/scenarios/<int:scenario_id>/duplicate")
def duplicate_scenario(scenario_id):
    database = get_db()
    source = database.execute("SELECT * FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
    if source is None:
        return jsonify(error="Scenario not found."), 404
    name = str((request.get_json(silent=True) or {}).get("name") or f"{source['name']} copy").strip()
    next_order = database.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM scenarios").fetchone()[0]
    cursor = database.execute("INSERT INTO scenarios (name, sort_order) VALUES (?, ?)", (name, next_order))
    new_id = cursor.lastrowid
    for table, columns in {
        "scenario_lots": "source_lot_id, lot_key, company, security, award_id, acquisition_date, original_shares, starting_shares, regular_tax_basis, amt_basis",
        "scenario_years": "tax_year, projected_price, salary, other_income, deductions, short_term_gains, long_term_gains",
        "scenario_prices": "price_date, projected_price",
    }.items():
        database.execute(
            f"INSERT INTO {table} (scenario_id, {columns}) SELECT ?, {columns} FROM {table} WHERE scenario_id = ?",
            (new_id, scenario_id),
        )
    transaction_columns = (
        "transaction_type", "transaction_date", "shares", "fmv", "price", "fees",
        "award_id", "selected_lot_key", "notes",
    )
    id_map = {}
    copied = []
    for row in database.execute(
        "SELECT * FROM scenario_transactions WHERE scenario_id = ? ORDER BY id", (scenario_id,)
    ):
        cursor = database.execute(
            f"""INSERT INTO scenario_transactions (scenario_id, {', '.join(transaction_columns)})
                VALUES (?, {', '.join('?' for _ in transaction_columns)})""",
            (new_id, *(row[column] for column in transaction_columns)),
        )
        id_map[row["id"]] = cursor.lastrowid
        copied.append((cursor.lastrowid, row["selected_lot_key"]))
    for new_transaction_id, lot_key in copied:
        if lot_key.startswith("t:") and int(lot_key[2:]) in id_map:
            database.execute(
                "UPDATE scenario_transactions SET selected_lot_key = ? WHERE id = ?",
                (f"t:{id_map[int(lot_key[2:])]}", new_transaction_id),
            )
    database.commit()
    return jsonify(message="Scenario duplicated", id=new_id), 201


@app.put("/api/scenarios/reorder")
def reorder_scenarios():
    ids = (request.get_json(silent=True) or {}).get("ids")
    if not isinstance(ids, list):
        return jsonify(error="Scenario order must be a list."), 400
    database = get_db()
    existing = {row[0] for row in database.execute("SELECT id FROM scenarios")}
    try:
        ordered_ids = [int(value) for value in ids]
    except (TypeError, ValueError):
        return jsonify(error="Scenario order contains an invalid ID."), 400
    if set(ordered_ids) != existing or len(ordered_ids) != len(existing):
        return jsonify(error="Scenario order must include every scenario exactly once."), 400
    database.executemany(
        "UPDATE scenarios SET sort_order = ? WHERE id = ?",
        [(index, scenario_id) for index, scenario_id in enumerate(ordered_ids, 1)],
    )
    database.commit()
    return jsonify(message="Scenario order saved")


@app.post("/api/scenarios/<int:scenario_id>/transactions")
def add_scenario_transaction(scenario_id):
    data = request.get_json(silent=True) or {}
    transaction_type = str(data.get("transaction_type") or "")
    transaction_date = str(data.get("transaction_date") or "")
    if transaction_type not in SCENARIO_TYPES or not transaction_date:
        return jsonify(error="Select a valid transaction type and date."), 400
    database = get_db()
    cursor = database.execute(
        """INSERT INTO scenario_transactions (
            scenario_id, transaction_type, transaction_date, shares, fmv, price, fees,
            award_id, selected_lot_key, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (scenario_id, transaction_type, transaction_date, number(data.get("shares")),
         number(data.get("fmv")), number(data.get("price")), number(data.get("fees")),
         data.get("award_id") or None, str(data.get("selected_lot_key") or ""),
         str(data.get("notes") or "")),
    )
    database.execute("UPDATE scenarios SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (scenario_id,))
    database.commit()
    calculation = calculate_scenario(database, scenario_id)
    transaction = next(row for row in calculation["transactions"] if row["id"] == cursor.lastrowid)
    return jsonify(message="Scenario transaction added", transaction=transaction), 201


@app.delete("/api/scenarios/<int:scenario_id>/transactions/<int:transaction_id>")
def delete_scenario_transaction(scenario_id, transaction_id):
    cursor = get_db().execute(
        "DELETE FROM scenario_transactions WHERE scenario_id = ? AND id = ?", (scenario_id, transaction_id)
    )
    get_db().commit()
    return (jsonify(message="Transaction deleted") if cursor.rowcount else (jsonify(error="Transaction not found."), 404))


@app.put("/api/scenarios/<int:scenario_id>/years/<int:tax_year>")
def save_scenario_year(scenario_id, tax_year):
    data = request.get_json(silent=True) or {}
    fields = ("projected_price", "salary", "other_income", "deductions", "short_term_gains", "long_term_gains")
    values = [number(data.get(field)) for field in fields]
    database = get_db()
    database.execute(
        f"""INSERT INTO scenario_years (scenario_id, tax_year, {', '.join(fields)})
            VALUES (?, ?, {', '.join('?' for _ in fields)})
            ON CONFLICT(scenario_id, tax_year) DO UPDATE SET
            {', '.join(f'{field}=excluded.{field}' for field in fields)}""",
        (scenario_id, tax_year, *values),
    )
    database.execute("UPDATE scenarios SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (scenario_id,))
    database.commit()
    return jsonify(message="Year projection saved")


@app.post("/api/scenarios/<int:scenario_id>/prices")
def save_scenario_price(scenario_id):
    data = request.get_json(silent=True) or {}
    price_date = str(data.get("price_date") or "")
    if not price_date:
        return jsonify(error="Price date or year is required."), 400
    database = get_db()
    database.execute(
        """INSERT INTO scenario_prices (scenario_id, price_date, projected_price) VALUES (?, ?, ?)
           ON CONFLICT(scenario_id, price_date) DO UPDATE SET projected_price=excluded.projected_price""",
        (scenario_id, price_date, number(data.get("projected_price"))),
    )
    database.commit()
    return jsonify(message="Projected price saved")


@app.delete("/api/clear/<section>")
def clear_page_data(section):
    database = get_db()
    try:
        if section == "profile":
            database.execute("DELETE FROM tax_profiles")
        elif section == "awards":
            acquisition_ids = [
                row[0] for row in database.execute(
                    "SELECT id FROM transactions WHERE award_id IS NOT NULL AND transaction_type IN ('Option exercise','Vesting / RSU settlement')"
                )
            ]
            if acquisition_ids:
                placeholders = ", ".join("?" for _ in acquisition_ids)
                database.execute(f"DELETE FROM transactions WHERE selected_lot_id IN ({placeholders})", acquisition_ids)
            database.execute("DELETE FROM transactions WHERE award_id IS NOT NULL")
            database.execute("DELETE FROM exercises")
            database.execute("DELETE FROM vesting_events")
            database.execute("DELETE FROM equity_awards")
            rebuild_portfolio_lots(database)
        elif section == "exercises":
            acquisition_ids = [row[0] for row in database.execute("SELECT transaction_id FROM exercises WHERE transaction_id IS NOT NULL")]
            if acquisition_ids:
                placeholders = ", ".join("?" for _ in acquisition_ids)
                database.execute(f"DELETE FROM transactions WHERE selected_lot_id IN ({placeholders})", acquisition_ids)
                database.execute(f"DELETE FROM transactions WHERE id IN ({placeholders})", acquisition_ids)
            database.execute("DELETE FROM exercises")
            rebuild_portfolio_lots(database)
        elif section == "transactions":
            database.execute("DELETE FROM transactions")
            database.execute("DELETE FROM exercises")
            rebuild_portfolio_lots(database)
        elif section == "lots":
            acquisition_ids = [
                row[0] for row in database.execute(
                    "SELECT id FROM transactions WHERE transaction_status = 'Historical' AND transaction_type IN ('Option exercise','Vesting / RSU settlement')"
                )
            ]
            if acquisition_ids:
                placeholders = ", ".join("?" for _ in acquisition_ids)
                database.execute(f"DELETE FROM transactions WHERE selected_lot_id IN ({placeholders})", acquisition_ids)
                database.execute(f"DELETE FROM transactions WHERE id IN ({placeholders})", acquisition_ids)
                database.execute(f"DELETE FROM exercises WHERE transaction_id IN ({placeholders})", acquisition_ids)
            rebuild_portfolio_lots(database)
        elif section == "imports":
            database.execute("DELETE FROM import_batches")
        elif section == "scenarios":
            for table in ("scenario_transactions", "scenario_lots", "scenario_years", "scenario_prices", "scenarios"):
                database.execute(f"DELETE FROM {table}")
        else:
            return jsonify(error="Unknown page data type."), 404
        database.commit()
    except (ValueError, sqlite3.Error) as error:
        database.rollback()
        return jsonify(error=f"Could not clear data: {error}"), 409
    return jsonify(message="Page data cleared")


@app.get("/health")
def health():
    return jsonify(status="ok")


with app.app_context():
    init_db()


if __name__ == "__main__":
    app.run(host="localhost", port=5001, debug=True)
