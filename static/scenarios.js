const tabs = document.querySelector('#scenarioTabs');
const workspace = document.querySelector('#scenarioWorkspace');
const sortControl = document.querySelector('#scenarioSort');
const scenarioTransactionForm = document.querySelector('#scenarioTransactionForm');
const scenarioType = document.querySelector('#scenarioTransactionType');
let scenarios = []; let current = null; let awards = [];
const safe = (value) => { const node = document.createElement('span'); node.textContent = value ?? ''; return node.innerHTML; };
const num = (value) => Number(value || 0).toLocaleString();
const money = (value) => Number(value || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const prettyDate = (value) => value ? new Date(`${value}T00:00:00`).toLocaleDateString() : '—';

const scenarioTypeConfig = {
  'Option exercise': {
    fields: ['shares', 'award', 'fmv', 'price'], awardTypes: ['ISO', 'NSO'],
    sharesLabel: 'Options to exercise', priceLabel: 'Exercise price / share',
    help: 'Creates a projected option lot. FMV determines the ISO AMT adjustment or NSO compensation income.',
  },
  'Vesting / RSU settlement': {
    fields: ['shares', 'award', 'fmv'], awardTypes: ['RSU'],
    sharesLabel: 'Shares settling', priceLabel: '',
    help: 'Creates a projected RSU lot. FMV becomes compensation income and regular-tax basis.',
  },
  'Tax withholding': {
    fields: ['shares', 'lot', 'price'], awardTypes: [],
    sharesLabel: 'Shares withheld', priceLabel: 'Share value / share',
    help: 'Uses shares from an existing or projected lot to cover estimated taxes.',
  },
  'Share sale': {
    fields: ['shares', 'lot', 'price', 'fees'], awardTypes: [],
    sharesLabel: 'Shares to sell', priceLabel: 'Sale price / share',
    help: 'Uses a specific lot so holding period, regular basis, and AMT basis can be tracked.',
  },
};

function updateScenarioTransactionForm() {
  const config = scenarioTypeConfig[scenarioType.value];
  ['shares', 'award', 'lot', 'fmv', 'price', 'fees'].forEach((name) => {
    const wrapper = document.querySelector(`[data-scenario-field="${name}"]`);
    const control = wrapper.querySelector('input, select');
    const visible = config.fields.includes(name);
    wrapper.hidden = !visible;
    control.disabled = !visible;
    control.required = visible && ['shares', 'award', 'lot', 'fmv', 'price'].includes(name);
  });
  document.querySelector('#scenarioSharesLabel').textContent = config.sharesLabel;
  document.querySelector('#scenarioPriceLabel').textContent = config.priceLabel;
  document.querySelector('#scenarioFormHelp').textContent = config.help;

  const selectedAward = document.querySelector('#scenarioAward').value;
  const eligibleAwards = awards.filter((award) => config.awardTypes.includes(award.award_type));
  document.querySelector('#scenarioAward').innerHTML = '<option value="">Select an award</option>' + eligibleAwards.map((award) => `<option value="${award.id}">${safe(award.company)} · ${safe(award.award_type)}${award.grant_number ? ` · Grant ${safe(award.grant_number)}` : ''} · ${num(award.shares_available)} available</option>`).join('');
  if (eligibleAwards.some((award) => String(award.id) === selectedAward)) document.querySelector('#scenarioAward').value = selectedAward;

  const selectedLot = document.querySelector('#scenarioLot').value;
  const transactionDate = scenarioTransactionForm.elements.transaction_date.value;
  const eligibleLots = (current?.lots || []).filter((lot) => lot.shares_remaining > 0 && (!transactionDate || lot.acquisition_date <= transactionDate));
  document.querySelector('#scenarioLot').innerHTML = '<option value="">Select a lot</option>' + eligibleLots.map((lot) => {
    const award = awards.find((item) => item.id === lot.award_id);
    return `<option value="${lot.lot_key}">${safe(lot.company)}${award?.grant_number ? ` · Grant ${safe(award.grant_number)}` : ''} · ${num(lot.shares_remaining)} available · ${prettyDate(lot.acquisition_date)}</option>`;
  }).join('');
  if (eligibleLots.some((lot) => lot.lot_key === selectedLot)) document.querySelector('#scenarioLot').value = selectedLot;
}

function scenarioTransactionDetails(transaction) {
  const shares = Number(transaction.shares || 0);
  if (transaction.transaction_type === 'Option exercise') return [
    ['Options exercised', num(shares)], ['FMV / share', money(transaction.fmv)],
    ['Exercise price', money(transaction.price)], ['Exercise spread', money(Math.max(0, transaction.fmv - transaction.price) * shares)],
  ];
  if (transaction.transaction_type === 'Vesting / RSU settlement') return [
    ['Shares settling', num(shares)], ['FMV / share', money(transaction.fmv)],
    ['Compensation income', money(transaction.fmv * shares)], ['New lot', 'Projected'],
  ];
  if (transaction.transaction_type === 'Tax withholding') return [
    ['Shares withheld', num(shares)], ['Share value', money(transaction.price)],
    ['Estimated value', money(transaction.price * shares)], ['Source lot', safe(transaction.selected_lot_key || '—')],
  ];
  return [
    ['Shares sold', num(shares)], ['Sale price', money(transaction.price)],
    ['Net proceeds', money(transaction.price * shares - transaction.fees)], ['Fees', money(transaction.fees)],
  ];
}

function scenarioTransactionDetailHtml(transaction) {
  return scenarioTransactionDetails(transaction).map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function sortedScenarios() {
  const sorted = [...scenarios];
  if (sortControl.value === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (sortControl.value === 'recent') sorted.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id);
  return sorted;
}

function renderScenarioNavigation() {
  const visible = sortedScenarios();
  const custom = sortControl.value === 'custom';
  tabs.innerHTML = visible.map((scenario) => `<button class="${current?.id === scenario.id ? 'selected' : ''}" data-scenario="${scenario.id}" draggable="${custom}"><i aria-hidden="true">${custom ? '⋮⋮' : ''}</i><span>${safe(scenario.name)}</span>${scenario.invalid ? ` <b>${scenario.invalid} invalid</b>` : ''}</button>`).join('') || '<p>No scenarios yet.</p>';
  document.querySelector('.scenario-sidebar-heading span').textContent = custom ? 'Drag to reorder' : '';
}

async function loadScenarios(selectId) {
  const [scenarioResponse, awardResponse] = await Promise.all([fetch('/api/scenarios'), fetch('/api/awards')]);
  scenarios = await scenarioResponse.json(); awards = await awardResponse.json();
  renderScenarioNavigation();
  document.querySelector('#scenarioComparison').innerHTML = scenarios.map((scenario) => `<div><span>${safe(scenario.name)}</span><strong>${num(scenario.shares_remaining)} shares</strong><small>${scenario.transactions} transactions · ${scenario.invalid} invalid · ${money(scenario.projected_income)} income</small></div>`).join('');
  updateScenarioTransactionForm();
  const target = selectId || current?.id;
  if (target && scenarios.some((item) => item.id === target)) await openScenario(target);
  else if (scenarios.length) await openScenario(scenarios[0].id);
  else { current = null; workspace.hidden = true; }
}

async function openScenario(id) {
  const response = await fetch(`/api/scenarios/${id}`); current = await response.json(); workspace.hidden = false;
  document.querySelector('#scenarioName').value = current.name;
  document.querySelector('#scenarioTxCount').textContent = current.summary.transactions;
  document.querySelector('#scenarioInvalid').textContent = current.summary.invalid;
  document.querySelector('#scenarioShares').textContent = num(current.summary.shares_remaining);
  tabs.querySelectorAll('button').forEach((button) => button.classList.toggle('selected', Number(button.dataset.scenario) === id));
  updateScenarioTransactionForm();
  document.querySelector('#scenarioTimeline').innerHTML = current.transactions.length ? current.transactions.map((tx) => `<article class="transaction-card ${tx.valid ? '' : 'invalid-transaction'}"><div class="transaction-heading"><div><h2>${safe(tx.transaction_type)}</h2><p>${prettyDate(tx.transaction_date)}</p></div><div class="transaction-actions">${tx.valid ? '<span class="status-badge future">Valid</span>' : `<span class="error-badge">${safe(tx.error)}</span>`}<button data-delete-tx="${tx.id}">Delete</button></div></div><div class="transaction-details">${scenarioTransactionDetailHtml(tx)}</div></article>`).join('') : '<div class="empty-state">No hypothetical transactions.</div>';
  document.querySelector('#yearRows').innerHTML = current.years.map((year) => `<tr><td>${year.tax_year}</td><td>${money(year.projected_price)}</td><td>${money(year.salary)}</td><td>${money(year.other_income)}</td><td>${money(year.deductions)}</td><td>${money(year.short_term_gains)}</td><td>${money(year.long_term_gains)}</td></tr>`).join('') || '<tr><td colspan="7" class="table-empty">No annual projections.</td></tr>';
  document.querySelector('#priceRows').innerHTML = current.prices.map((price) => `<tr><td>${safe(price.price_date)}</td><td>${money(price.projected_price)}</td></tr>`).join('') || '<tr><td colspan="2" class="table-empty">No dated price projections.</td></tr>';
}

tabs.addEventListener('click', (event) => { const button = event.target.closest('[data-scenario]'); if (button) openScenario(Number(button.dataset.scenario)); });
sortControl.value = localStorage.getItem('scenarioSort') || 'custom';
sortControl.addEventListener('change', () => { localStorage.setItem('scenarioSort', sortControl.value); renderScenarioNavigation(); });
let draggedScenario = null;
tabs.addEventListener('dragstart', (event) => {
  if (sortControl.value !== 'custom') { event.preventDefault(); return; }
  draggedScenario = event.target.closest('[data-scenario]');
  if (draggedScenario) draggedScenario.classList.add('dragging');
});
tabs.addEventListener('dragover', (event) => {
  if (!draggedScenario) return;
  event.preventDefault();
  const target = event.target.closest('[data-scenario]');
  if (target && target !== draggedScenario) {
    const box = target.getBoundingClientRect();
    tabs.insertBefore(draggedScenario, event.clientY < box.top + box.height / 2 ? target : target.nextSibling);
  }
});
tabs.addEventListener('dragend', async () => {
  if (!draggedScenario) return;
  draggedScenario.classList.remove('dragging'); draggedScenario = null;
  const ids = [...tabs.querySelectorAll('[data-scenario]')].map((button) => Number(button.dataset.scenario));
  await fetch('/api/scenarios/reorder', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ids}) });
  await loadScenarios(current?.id);
});
document.querySelector('#newScenario').addEventListener('click', async () => { const r = await fetch('/api/scenarios',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); const x=await r.json(); if(r.ok) loadScenarios(x.id); });
async function saveScenarioName() {
  const input = document.querySelector('#scenarioName');
  const name = input.value.trim();
  if (!current || !name || name === current.name) { if (current && !name) input.value = current.name; return; }
  const response = await fetch(`/api/scenarios/${current.id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name}) });
  if (response.ok) { current.name = name; await loadScenarios(current.id); }
  else input.value = current.name;
}
document.querySelector('#scenarioName').addEventListener('blur', saveScenarioName);
document.querySelector('#scenarioName').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); event.target.blur(); } });
document.querySelector('#duplicateScenario').addEventListener('click', async () => { const name=prompt('Name for duplicate:',`${current.name} copy`); if(!name)return; const r=await fetch(`/api/scenarios/${current.id}/duplicate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})}); const x=await r.json(); loadScenarios(x.id); });
document.querySelector('#deleteScenario').addEventListener('click', async () => { if(!confirm(`Delete ${current.name}?`))return; await fetch(`/api/scenarios/${current.id}`,{method:'DELETE'}); loadScenarios(); });
scenarioTransactionForm.addEventListener('submit', async (event) => { event.preventDefault(); const body=Object.fromEntries(new FormData(event.target)); const r=await fetch(`/api/scenarios/${current.id}/transactions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const x=await r.json(); document.querySelector('#scenarioMessage').textContent=x.transaction?.error||x.error||''; if(r.ok){event.target.reset(); updateScenarioTransactionForm(); await loadScenarios(current.id);} });
scenarioType.addEventListener('change', updateScenarioTransactionForm);
scenarioTransactionForm.elements.transaction_date.addEventListener('change', updateScenarioTransactionForm);
document.querySelector('#scenarioAward').addEventListener('change', () => {
  if (scenarioType.value !== 'Option exercise') return;
  const award = awards.find((item) => item.id === Number(document.querySelector('#scenarioAward').value));
  if (award) scenarioTransactionForm.elements.price.value = award.strike_price;
});
document.querySelector('#scenarioTimeline').addEventListener('click', async (event) => { const button=event.target.closest('[data-delete-tx]'); if(!button)return; await fetch(`/api/scenarios/${current.id}/transactions/${button.dataset.deleteTx}`,{method:'DELETE'}); loadScenarios(current.id); });
document.querySelector('#yearForm').addEventListener('submit', async (event) => { event.preventDefault(); const body=Object.fromEntries(new FormData(event.target)); await fetch(`/api/scenarios/${current.id}/years/${body.tax_year}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); loadScenarios(current.id); });
document.querySelector('#priceForm').addEventListener('submit', async (event) => { event.preventDefault(); const body=Object.fromEntries(new FormData(event.target)); await fetch(`/api/scenarios/${current.id}/prices`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); loadScenarios(current.id); });
loadScenarios();
