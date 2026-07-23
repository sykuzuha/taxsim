const formCard = document.querySelector('#transactionFormCard');
const form = document.querySelector('#transactionForm');
const list = document.querySelector('#transactionList');
const message = document.querySelector('#transactionMessage');
const toast = document.querySelector('#transactionToast');
const filter = document.querySelector('#transactionFilter');
let transactions = [];
let lots = [];
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
}

function showForm() { formCard.hidden = false; document.querySelector('#openTransactionForm').hidden = true; formCard.scrollIntoView({ behavior: 'smooth' }); }
function hideForm() { formCard.hidden = true; document.querySelector('#openTransactionForm').hidden = false; message.textContent = ''; }

function renderLots() {
  const select = document.querySelector('#selectedLot');
  const currentValue = select.value;
  select.innerHTML = '<option value="">None</option>' + lots.map((lot) => `<option value="${lot.source_transaction_id}">${date(lot.acquisition_date)} · ${safe(lot.acquisition_type)} · ${number(lot.shares_remaining)} remaining</option>`).join('');
  select.value = currentValue;
}

function renderTransactions() {
  const visible = filter.value === 'All' ? transactions : transactions.filter((item) => item.transaction_status === filter.value);
  document.querySelector('#transactionCount').textContent = transactions.length;
  document.querySelector('#historicalCount').textContent = transactions.filter((item) => item.transaction_status === 'Historical').length;
  document.querySelector('#futureCount').textContent = transactions.filter((item) => item.transaction_status === 'Future simulated').length;
  if (!visible.length) { list.innerHTML = '<div class="empty-state"><h2>No transactions found</h2><p>Add a transaction or choose another filter.</p></div>'; return; }
  list.innerHTML = visible.map((item) => `
    <article class="transaction-card">
      <div class="transaction-heading"><div><h2>${safe(item.transaction_type)}</h2><p>${date(item.transaction_date)}</p></div><div class="transaction-actions"><span class="status-badge ${item.transaction_status === 'Future simulated' ? 'future' : ''}">${safe(item.transaction_status)}</span><button class="edit-transaction" type="button" data-edit="${item.id}">Edit</button><button type="button" data-delete="${item.id}">Delete</button></div></div>
      <div class="transaction-details"><div><span>Shares</span><strong>${number(item.shares)}</strong></div><div><span>FMV / share</span><strong>${money(item.fmv)}</strong></div><div><span>Price / share</span><strong>${money(item.price)}</strong></div><div><span>Fees</span><strong>${money(item.fees)}</strong></div></div>
      <div class="transaction-notes"><p><strong>Regular / AMT basis:</strong> ${money(item.regular_tax_basis)} / ${money(item.amt_basis)}</p><p><strong>Holding-period start:</strong> ${date(item.holding_period_start)}</p><p><strong>Selected lots:</strong> ${safe(item.selected_lots || (item.selected_lot_id ? `Acquisition transaction #${item.selected_lot_id}` : 'None'))}</p>${item.notes ? `<p><strong>Notes:</strong> ${safe(item.notes)}</p>` : ''}</div>
    </article>`).join('');
}

async function loadLedger() {
  try {
    const [transactionResponse, lotResponse] = await Promise.all([fetch('/api/transactions'), fetch('/api/lots')]);
    if (!transactionResponse.ok || !lotResponse.ok) throw new Error('Could not load the portfolio ledger');
    transactions = await transactionResponse.json(); lots = await lotResponse.json();
    renderTransactions(); renderLots();
  } catch (error) { list.innerHTML = `<div class="empty-state"><h2>Could not load transactions</h2><p>${safe(error.message)}</p></div>`; }
}

function editTransaction(id) {
  const transaction = transactions.find((item) => item.id === id); if (!transaction) return;
  editingId = id;
  Object.entries(transaction).forEach(([name, value]) => { const field = form.elements.namedItem(name); if (field) field.value = value ?? ''; });
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
filter.addEventListener('change', renderTransactions);
loadLedger();
