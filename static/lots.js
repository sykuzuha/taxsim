const lotsBody = document.querySelector('#lotsBody');
const lotFilter = document.querySelector('#lotFilter');
let lots = [];

function safe(value) { const element = document.createElement('span'); element.textContent = value ?? ''; return element.innerHTML; }
function number(value) { return Number(value || 0).toLocaleString(); }
function money(value) { return Number(value || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' }); }
function date(value) { return value ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'; }

function renderLots() {
  document.querySelector('#sharesAcquired').textContent = number(lots.reduce((sum, lot) => sum + lot.shares_acquired, 0));
  document.querySelector('#sharesSold').textContent = number(lots.reduce((sum, lot) => sum + lot.shares_sold, 0));
  document.querySelector('#sharesRemaining').textContent = number(lots.reduce((sum, lot) => sum + lot.shares_remaining, 0));
  const visible = lotFilter.value === 'All' ? lots : lots.filter((lot) => lot.status === lotFilter.value);
  lotsBody.innerHTML = visible.length ? visible.map((lot) => {
    const history = lot.transaction_history.map((item) => `
      <tr><td>${date(item.transaction_date)}</td><td>${safe(item.transaction_type)}</td><td>${number(item.shares)}</td><td>${money(item.price)}</td><td>${money(item.fees)}</td><td>${safe(item.notes || '—')}</td></tr>
    `).join('');
    return `<article class="lot-card">
      <div class="lot-heading">
        <div><h2>${safe(lot.company || 'Unknown company')}</h2><p>${safe(lot.security || 'Unknown security')} · ${safe(lot.acquisition_type)}${lot.grant_number ? ` · Grant ${safe(lot.grant_number)}` : ''}</p></div>
        <span class="lot-status ${lot.status === 'Fully sold' ? 'sold' : ''}">${safe(lot.status)}</span>
      </div>
      <div class="lot-share-grid">
        <div><span>Acquisition date</span><strong>${date(lot.acquisition_date)}</strong></div>
        <div><span>Original shares</span><strong>${number(lot.shares_acquired)}</strong></div>
        <div><span>Shares sold</span><strong>${number(lot.shares_sold)}</strong></div>
        <div><span>Remaining shares</span><strong>${number(lot.shares_remaining)}</strong></div>
        <div><span>FMV at acquisition</span><strong>${money(lot.fmv_at_acquisition)}</strong></div>
      </div>
      <div class="lot-basis-grid">
        <div><span>Regular basis / share</span><strong>${money(lot.regular_tax_basis_per_share)}</strong></div>
        <div><span>Total regular basis</span><strong>${money(lot.regular_tax_basis)}</strong></div>
        <div><span>AMT basis / share</span><strong>${money(lot.amt_basis_per_share)}</strong></div>
        <div><span>Total AMT basis</span><strong>${money(lot.amt_basis)}</strong></div>
      </div>
      <div class="lot-dates">
        <span><strong>Holding-period start:</strong> ${date(lot.holding_period_start)}</span>
        <span><strong>QSBS holding-period start:</strong> ${date(lot.qsbs_holding_period_start)}</span>
        <span><strong>Source award:</strong> ${lot.source_award_id ? `#${lot.source_award_id} · ${safe(lot.award_type || '')}` : 'Not linked'}</span>
      </div>
      <button class="secondary-button lot-history-toggle" type="button" data-history-toggle aria-expanded="false">View transaction history (${lot.transaction_history.length})</button>
      <div class="lot-history" hidden>
        <div class="lots-table-wrap"><table class="lots-table"><thead><tr><th>Date</th><th>Transaction</th><th>Shares</th><th>Price</th><th>Fees</th><th>Notes</th></tr></thead><tbody>${history}</tbody></table></div>
      </div>
    </article>`;
  }).join('') : '<div class="empty-state"><h2>No lots found</h2><p>Choose another filter or record a completed exercise or settlement.</p></div>';
}

lotsBody.addEventListener('click', (event) => {
  const button = event.target.closest('[data-history-toggle]');
  if (!button) return;
  const history = button.nextElementSibling;
  const expanded = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(expanded));
  button.textContent = expanded ? 'Hide transaction history' : `View transaction history (${history.querySelectorAll('tbody tr').length})`;
  history.hidden = !expanded;
});
lotFilter.addEventListener('change', renderLots);

async function loadLots() {
  try {
    const response = await fetch('/api/lots');
    if (!response.ok) throw new Error('Could not load lots');
    lots = await response.json();
    renderLots();
  } catch (error) {
    lotsBody.innerHTML = `<div class="empty-state">${safe(error.message)}</div>`;
  }
}
loadLots();
