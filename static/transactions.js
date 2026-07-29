const formCard = document.querySelector('#transactionFormCard');
const form = document.querySelector('#transactionForm');
const list = document.querySelector('#transactionList');
const message = document.querySelector('#transactionMessage');
const toast = document.querySelector('#transactionToast');
const filter = document.querySelector('#transactionFilter');
let transactions = [];
let lots = [];
let awards = [];
let editingId = null;

function safe(value) { const element = document.createElement('span'); element.textContent = value; return element.innerHTML; }
function number(value) { return Number(value || 0).toLocaleString(); }
function money(value) { return Number(value || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' }); }
function date(value) { return value ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'; }
function showToast(value) { toast.textContent = value; toast.classList.add('show'); window.setTimeout(() => toast.classList.remove('show'), 2200); }

function resetForm() {
  editingId = null;
  form.reset();
  document.querySelector('#transactionFormTitle').textContent = 'Add transaction';
  document.querySelector('#transactionSubmit').textContent = 'Save transaction';
  message.textContent = '';
  updateTransactionFields();
}

function showForm() { formCard.hidden = false; document.querySelector('#openTransactionForm').hidden = true; formCard.scrollIntoView({ behavior: 'smooth' }); }
function hideForm() { formCard.hidden = true; document.querySelector('#openTransactionForm').hidden = false; message.textContent = ''; }

function renderLots() {
  const select = document.querySelector('#selectedLot');
  const currentValue = select.value;
  select.innerHTML = '<option value="">None</option>' + lots.map((lot) => `<option value="${lot.source_transaction_id}" data-award-id="${lot.source_award_id || ''}">${date(lot.acquisition_date)} · ${safe(lot.acquisition_type)} · ${number(lot.shares_remaining)} remaining${lot.grant_number ? ` · Grant ${safe(lot.grant_number)}` : ''}</option>`).join('');
  select.value = currentValue;
}

function renderAwards() {
  const select = document.querySelector('#transactionAward');
  const current = select.value;
  select.innerHTML = '<option value="">None</option>' + awards.map((award) =>
    `<option value="${award.id}">${safe(award.company)} · ${safe(award.award_type)} · ${award.grant_number ? `Grant ${safe(award.grant_number)} · ` : ''}${date(award.grant_date)}</option>`
  ).join('');
  select.value = current;
}

function updateTransactionFields() {
  const type = form.elements.transaction_type.value;
  const future = form.elements.transaction_status.value === 'Future simulated';
  document.querySelector('.scenario-field').hidden = !future;
  form.elements.scenario_name.required = future;
  document.querySelector('.award-field').hidden = false;
  form.elements.award_id.required = true;
  document.querySelector('.shares-field').hidden = type === 'Fee';
  form.elements.shares.required = type !== 'Fee';
  document.querySelector('.fmv-field').hidden = !['Option exercise', 'Vesting / RSU settlement'].includes(type);
  document.querySelector('.price-field').hidden = !['Option exercise', 'Share sale'].includes(type);
  document.querySelector('#priceLabel').textContent = type === 'Option exercise' ? 'Strike price per share' : 'Sale price per share';
  document.querySelector('#selectedLot').closest('label').hidden = !['Share sale', 'Tax withholding'].includes(type);
}

function renderTransactions() {
  const visible = filter.value === 'All' ? transactions : transactions.filter((item) => item.transaction_status === filter.value);
  document.querySelector('#transactionCount').textContent = transactions.length;
  document.querySelector('#historicalCount').textContent = transactions.filter((item) => item.transaction_status === 'Historical').length;
  document.querySelector('#futureCount').textContent = transactions.filter((item) => item.transaction_status === 'Future simulated').length;
  if (!visible.length) { list.innerHTML = '<div class="empty-state"><h2>No transactions found</h2><p>Add a transaction or choose another filter.</p></div>'; return; }
  list.innerHTML = visible.map((item) => `
    <article class="transaction-card">
      <div class="transaction-heading"><div><h2>${safe(item.transaction_type)}</h2><p>${date(item.transaction_date)}${item.display_company ? ` · ${safe(item.display_company)}` : ''}${item.display_security ? ` · ${safe(item.display_security)}` : ''}${item.grant_number && item.award_id ? ` · <a class="grant-link" href="/awards?award_id=${Number(item.award_id)}">Grant ${safe(item.grant_number)}</a>` : ''}${item.scenario_name ? ` · Scenario: ${safe(item.scenario_name)}` : ''}</p></div><div class="transaction-actions"><span class="status-badge ${item.transaction_status === 'Future simulated' ? 'future' : ''}">${safe(item.transaction_status)}</span><button class="edit-transaction" type="button" data-edit="${item.id}">Edit</button><button type="button" data-delete="${item.id}">Delete</button></div></div>
      <div class="transaction-details"><div><span>Shares</span><strong>${number(item.shares)}</strong></div><div><span>FMV / share</span><strong>${money(item.fmv)}</strong></div><div><span>Price / share</span><strong>${money(item.price)}</strong></div><div><span>Fees</span><strong>${money(item.fees)}</strong></div></div>
      <div class="transaction-notes"><p><strong>Regular / AMT basis:</strong> ${money(item.regular_tax_basis)} / ${money(item.amt_basis)}</p><p><strong>Holding-period start:</strong> ${date(item.holding_period_start)}</p><p><strong>Selected lots:</strong> ${safe(item.selected_lots || (item.selected_lot_id ? `Acquisition transaction #${item.selected_lot_id}` : 'None'))}</p>${item.notes ? `<p><strong>Notes:</strong> ${safe(item.notes)}</p>` : ''}</div>
    </article>`).join('');
}

async function loadLedger() {
  try {
    const [transactionResponse, lotResponse, awardResponse] = await Promise.all([fetch('/api/transactions'), fetch('/api/lots'), fetch('/api/awards')]);
    if (!transactionResponse.ok || !lotResponse.ok || !awardResponse.ok) throw new Error('Could not load the portfolio ledger');
    transactions = await transactionResponse.json(); lots = await lotResponse.json(); awards = await awardResponse.json();
    renderTransactions(); renderLots(); renderAwards();
  } catch (error) { list.innerHTML = `<div class="empty-state"><h2>Could not load transactions</h2><p>${safe(error.message)}</p></div>`; }
}

function editTransaction(id) {
  const transaction = transactions.find((item) => item.id === id); if (!transaction) return;
  editingId = id;
  Object.entries(transaction).forEach(([name, value]) => { const field = form.elements.namedItem(name); if (field) field.value = value ?? ''; });
  updateTransactionFields();
  document.querySelector('#transactionFormTitle').textContent = 'Edit transaction';
  document.querySelector('#transactionSubmit').textContent = 'Update transaction';
  showForm();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault(); message.textContent = 'Saving...';
  try {
    const response = await fetch(editingId ? `/api/transactions/${editingId}` : '/api/transactions', { method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not save transaction');
    const resultMessage = editingId ? 'Transaction updated' : 'Transaction saved'; resetForm(); hideForm(); showToast(resultMessage); await loadLedger();
  } catch (error) { message.textContent = error.message; }
});

list.addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit]'); if (editButton) { editTransaction(Number(editButton.dataset.edit)); return; }
  const deleteButton = event.target.closest('[data-delete]'); if (!deleteButton || !window.confirm('Delete this transaction?')) return;
  const response = await fetch(`/api/transactions/${deleteButton.dataset.delete}`, { method: 'DELETE' }); const result = await response.json();
  if (response.ok) { if (editingId === Number(deleteButton.dataset.delete)) { resetForm(); hideForm(); } showToast('Transaction deleted'); await loadLedger(); }
  else window.alert(result.error || 'Could not delete transaction');
});

document.querySelector('#openTransactionForm').addEventListener('click', () => { resetForm(); showForm(); });
document.querySelector('#closeTransactionForm').addEventListener('click', () => { resetForm(); hideForm(); });
document.querySelector('#transactionType').addEventListener('change', updateTransactionFields);
document.querySelector('#transactionStatus').addEventListener('change', updateTransactionFields);
document.querySelector('#transactionAward').addEventListener('change', () => {
  const award = awards.find((item) => item.id === Number(form.elements.award_id.value));
  if (!award) return;
  form.elements.company.value = award.company;
  form.elements.security.value = award.security;
  if (form.elements.transaction_type.value === 'Option exercise') form.elements.price.value = award.strike_price;
});
document.querySelector('#selectedLot').addEventListener('change', (event) => {
  const awardId = event.target.selectedOptions[0]?.dataset.awardId;
  if (awardId) {
    form.elements.award_id.value = awardId;
    form.elements.award_id.dispatchEvent(new Event('change'));
  }
});
filter.addEventListener('change', renderTransactions);
updateTransactionFields();
loadLedger();
