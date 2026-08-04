const money = (value) => Number(value || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const number = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const date = (value) => value ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const safe = (value) => { const node = document.createElement('span'); node.textContent = value ?? ''; return node.innerHTML; };
let result;

document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('[data-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === button.dataset.tab));
}));

function emptyRow(columns, message) { return `<tr><td colspan="${columns}" class="result-empty">${message}</td></tr>`; }

function render(data) {
  result = data;
  const summary = data.summary;
  const totalTax = summary.federal_tax + summary.state_tax;
  document.querySelector('#profileNotice').hidden = data.profile_found;
  document.querySelector('#resultSubtitle').textContent = `${data.filing_status} · ${data.state} · ${data.tax_year}`;
  document.querySelector('#totalTax').textContent = money(totalTax);
  document.querySelector('#cashRequired').textContent = money(summary.cash_required);
  document.querySelector('#afterTax').textContent = money(summary.after_tax_proceeds);
  const denominator = summary.ordinary_income + Math.max(0, summary.ltcg);
  document.querySelector('#effectiveRate').textContent = denominator ? `${(totalTax / denominator * 100).toFixed(1)}% effective rate` : 'No taxable income';
  const metrics = [
    ['Federal tax', summary.federal_tax, 'Includes AMT and credits'],
    ['State tax', summary.state_tax, data.state],
    ['AMT', summary.amt, summary.amt ? 'Additional tax due' : 'No additional AMT'],
    ['Ordinary income', summary.ordinary_income, 'Salary + equity + short-term gains'],
    ['Short-term gains', summary.stcg, 'Taxed at ordinary rates'],
    ['Long-term gains', summary.ltcg, 'Preferential federal rate'],
  ];
  document.querySelector('#annualMetrics').innerHTML = metrics.map(([label, value, note]) => `<article><span>${label}</span><strong>${money(value)}</strong><small>${safe(note)}</small></article>`).join('');
  const composition = [['Federal regular + AMT', summary.federal_tax, '#315cf4'], ['State', summary.state_tax, '#7c5ce7'], ['Recorded withholding', summary.withholding, '#19a974']];
  const max = Math.max(...composition.map((item) => item[1]), 1);
  document.querySelector('#taxComposition').innerHTML = composition.map(([label, value, color]) => `<div><div class="composition-label"><span>${label}</span><strong>${money(value)}</strong></div><i><b style="width:${Math.max(2, value / max * 100)}%;background:${color}"></b></i></div>`).join('');

  const incomeRows = [
    ['Salary', data.income.salary, 'Profile'],
    ['ISO compensation', data.income.iso_compensation, 'Disqualifying dispositions'],
    ['NSO compensation', data.income.nso_compensation, 'Exercise spread'],
    ['RSU income', data.income.rsu_income, 'Settlement value'],
    ['Other income', data.income.other_income, 'Profile'],
  ];
  document.querySelector('#incomeBreakdown').innerHTML = incomeRows.map(([label, value, source]) => `<div class="breakdown-row"><div><span>${label}</span><small>${source}</small></div><strong>${money(value)}</strong></div>`).join('') + `<div class="breakdown-total"><span>Ordinary income incl. short-term gains</span><strong>${money(summary.ordinary_income)}</strong></div>`;

  document.querySelector('#capitalSummary').innerHTML = `<article><span>Short-term gain / loss</span><strong>${money(data.capital.short_term)}</strong><small>Held one year or less</small></article><article><span>Long-term gain / loss</span><strong>${money(data.capital.long_term)}</strong><small>Held more than one year</small></article>`;
  document.querySelector('#capitalRows').innerHTML = data.capital.sales.map((sale) => `<tr><td><strong>${safe(sale.company || 'Shares')}</strong><small>${date(sale.date)} · ${number(sale.shares)} shares</small></td><td><span class="classification">${safe(sale.classification)}</span></td><td>${money(sale.proceeds)}</td><td>${money(sale.basis)}</td><td class="${sale.gain < 0 ? 'negative' : ''}">${money(sale.gain)}</td><td class="${sale.amt_gain < 0 ? 'negative' : ''}">${money(sale.amt_gain)}</td></tr>`).join('') || emptyRow(6, 'No share sales recorded for this tax year.');

  const amt = data.amt;
  const bridge = [
    ['Ordinary income and gains', amt.amti - amt.iso_exercise_adjustment + data.assumptions.deduction],
    ['ISO exercise adjustment', amt.iso_exercise_adjustment],
    ['Less deduction', -data.assumptions.deduction],
    ['Alternative minimum taxable income', amt.amti, true],
    ['Less AMT exemption', -amt.exemption],
    ['Tentative minimum tax', amt.tentative_minimum_tax, true],
    ['Regular federal tax', -amt.regular_tax],
    ['Additional AMT due', amt.amt_due, true],
    ['AMT credit used', -amt.credit_used],
  ];
  document.querySelector('#amtBridge').innerHTML = bridge.map(([label, value, total]) => `<div class="bridge-row ${total ? 'total' : ''}"><span>${label}</span><strong>${value < 0 ? '−' : ''}${money(Math.abs(value))}</strong></div>`).join('');
  document.querySelector('#isoRows').innerHTML = data.iso_exercises.map((item) => `<tr><td><strong>${safe(item.company || 'ISO')}</strong><small>${date(item.date)}</small></td><td>${number(item.shares)}</td><td>${money(item.strike)}</td><td>${money(item.fmv)}</td><td>${money(item.spread)}</td><td>${money(item.regular_basis)} / ${money(item.amt_basis)}</td></tr>`).join('') || emptyRow(6, 'No ISO exercises recorded for this tax year.');
  renderDetails('all');
}

function renderDetails(filter) {
  const visible = result.details.filter((item) => filter === 'all' || (filter === 'disposition' ? item.type.toLowerCase().includes('disposition') : item.type.includes(filter)));
  document.querySelector('#calculationList').innerHTML = visible.map((item) => `<details class="calculation-card"><summary><div><span class="event-type">${safe(item.type)}</span><h3>${safe(item.title)}</h3><small>${date(item.date)}</small></div><div class="detail-amount"><strong>${money(item.amount)}</strong><i>⌄</i></div></summary><div class="tax-flow">${item.steps.map(([label, value], index) => `<div class="flow-step"><span>${safe(label)}</span><strong>${safe(value)}</strong></div>${index < item.steps.length - 1 ? '<b class="flow-arrow">→</b>' : ''}`).join('')}</div></details>`).join('') || '<div class="result-empty standalone">No matching transactions for this tax year.</div>';
}

document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('selected', item === button));
  renderDetails(button.dataset.filter);
}));

async function loadResults() {
  const year = document.querySelector('#taxYear').value;
  const response = await fetch(`/api/tax-results/${year}`);
  render(await response.json());
}
document.querySelector('#taxYear').addEventListener('change', loadResults);
loadResults();
