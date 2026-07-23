const lotsBody = document.querySelector('#lotsBody');

function safe(value) { const element = document.createElement('span'); element.textContent = value; return element.innerHTML; }
function number(value) { return Number(value || 0).toLocaleString(); }
function money(value) { return Number(value || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' }); }
function date(value) { return value ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'; }

function renderLots(lots) {
  document.querySelector('#sharesAcquired').textContent = number(lots.reduce((sum, lot) => sum + lot.shares_acquired, 0));
  document.querySelector('#sharesSold').textContent = number(lots.reduce((sum, lot) => sum + lot.shares_sold, 0));
  document.querySelector('#sharesRemaining').textContent = number(lots.reduce((sum, lot) => sum + lot.shares_remaining, 0));
  lotsBody.innerHTML = lots.length ? lots.map((lot) => `
    <tr>
      <td>${date(lot.acquisition_date)}</td><td>${safe(lot.acquisition_type)}</td>
      <td>${number(lot.shares_acquired)}</td><td>${number(lot.shares_sold)}</td>
      <td><strong>${number(lot.shares_remaining)}</strong></td>
      <td>${money(lot.regular_tax_basis)}</td><td>${money(lot.amt_basis)}</td>
      <td>${date(lot.holding_period_start)}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="table-empty">No completed exercises or RSU settlements yet.</td></tr>';
}

async function loadLots() {
  try {
    const response = await fetch('/api/lots');
    if (!response.ok) throw new Error('Could not load lots');
    renderLots(await response.json());
  } catch (error) {
    lotsBody.innerHTML = `<tr><td colspan="8" class="table-empty">${safe(error.message)}</td></tr>`;
  }
}

loadLots();
