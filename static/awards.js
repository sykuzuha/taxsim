const awardFormCard = document.querySelector('#awardFormCard');
const awardForm = document.querySelector('#awardForm');
const awardsList = document.querySelector('#awardsList');
const formMessage = document.querySelector('#formMessage');
const toast = document.querySelector('#toast');
const asOfInput = document.querySelector('#vestingAsOf');
const vestingEvents = document.querySelector('#vestingEvents');
let savedAwards = [];
let editingAwardId = null;

const awardNames = {
  ISO: 'Incentive stock option',
  NSO: 'Nonqualified stock option',
  RSU: 'Restricted stock unit',
};

function text(value) { const element = document.createElement('span'); element.textContent = value ?? ''; return element.innerHTML; }
function formatNumber(value) { return Number(value || 0).toLocaleString(); }
function formatMoney(value) { return Number(value || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' }); }
function formatDate(value) { return value ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Not provided'; }
function showToast(value) { toast.textContent = value; toast.classList.add('show'); window.setTimeout(() => toast.classList.remove('show'), 2200); }

function addVestingEvent(event = {}) {
  const row = document.createElement('tr');
  row.className = 'vesting-event-row';
  row.innerHTML = `
    <td><input type="date" data-vest-date value="${text(event.vest_date || '')}" required></td>
    <td><input type="number" data-vest-shares min="0.0001" step="0.0001" value="${text(event.shares || '')}" required></td>
    <td><button class="plain-button remove-vesting-event" type="button">Remove</button></td>`;
  vestingEvents.appendChild(row);
}

function addMonths(dateValue, months) {
  const [year, month, day] = dateValue.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result.toISOString().slice(0, 10);
}

function updateScheduleBuilder() {
  const type = document.querySelector('#scheduleType').value;
  const custom = type === 'custom';
  document.querySelector('#scheduleStart').disabled = custom;
  document.querySelector('#scheduleDuration').disabled = custom;
  document.querySelector('#scheduleCliff').disabled = custom;
  document.querySelector('#cliffField').hidden = type !== 'cliff-monthly';
  document.querySelector('#addVestingEvent').hidden = !custom;
  vestingEvents.querySelectorAll('input, button').forEach((control) => { control.disabled = !custom; });
  updateSchedule();
}

function scheduleDescription() {
  const type = document.querySelector('#scheduleType').value;
  const duration = Number(document.querySelector('#scheduleDuration').value);
  if (type === 'custom') return `${vestingEvents.children.length} custom vesting event${vestingEvents.children.length === 1 ? '' : 's'}`;
  const names = { monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual', 'cliff-monthly': 'Monthly' };
  const years = duration && duration % 12 === 0 ? `${duration / 12} year${duration === 12 ? '' : 's'}` : `${duration || 0} months`;
  return type === 'cliff-monthly' ? `${years}, monthly, ${document.querySelector('#scheduleCliff').value || 12}-month cliff` : `${years}, ${names[type].toLowerCase()}`;
}

function updateLiveSummary() {
  const granted = Number(awardForm.elements.shares_granted.value || 0);
  const canceled = Number(awardForm.elements.shares_canceled.value || 0);
  const vested = [...vestingEvents.querySelectorAll('.vesting-event-row')].reduce((sum, row) => {
    return sum + (row.querySelector('[data-vest-date]').value <= asOfInput.value ? Number(row.querySelector('[data-vest-shares]').value || 0) : 0);
  }, 0);
  const current = savedAwards.find((award) => award.id === editingAwardId);
  const exercised = current?.shares_exercised || 0;
  document.querySelector('#formGranted').textContent = formatNumber(granted);
  document.querySelector('#formVested').textContent = formatNumber(vested);
  document.querySelector('#formAvailable').textContent = formatNumber(Math.max(0, vested - exercised));
  document.querySelector('#formUnvested').textContent = formatNumber(Math.max(0, granted - vested - canceled));
  document.querySelector('#formAvailableLabel').textContent = awardForm.elements.award_type.value === 'RSU' ? 'Available' : 'Exercisable';
  const summary = scheduleDescription();
  document.querySelector('#scheduleSummary').textContent = summary;
  awardForm.elements.vesting_schedule.value = summary;
}

function updateSchedule() {
  const type = document.querySelector('#scheduleType').value;
  if (type === 'custom') { updateLiveSummary(); return; }
  const start = document.querySelector('#scheduleStart').value;
  const duration = Number(document.querySelector('#scheduleDuration').value);
  const granted = Number(awardForm.elements.shares_granted.value);
  if (!start || duration < 1 || granted <= 0) {
    vestingEvents.innerHTML = '';
    updateLiveSummary();
    return;
  }
  const interval = type === 'quarterly' ? 3 : type === 'annual' ? 12 : 1;
  const cliff = type === 'cliff-monthly' ? Math.min(duration, Number(document.querySelector('#scheduleCliff').value || 12)) : interval;
  vestingEvents.innerHTML = '';
  const offsets = [];
  for (let month = cliff; month <= duration; month += interval) offsets.push(month);
  if (offsets[offsets.length - 1] !== duration) offsets.push(duration);
  let allocated = 0;
  offsets.forEach((month, index) => {
    const priorMonth = index ? offsets[index - 1] : 0;
    const shares = index === offsets.length - 1
      ? granted - allocated
      : Number((granted * (month - priorMonth) / duration).toFixed(4));
    allocated += shares;
    addVestingEvent({ vest_date: addMonths(start, month), shares });
  });
  vestingEvents.querySelectorAll('input, button').forEach((control) => { control.disabled = true; });
  updateLiveSummary();
}

function toggleOptionFields() {
  const isOption = awardForm.elements.award_type.value !== 'RSU';
  document.querySelectorAll('.option-field').forEach((field) => { field.hidden = !isOption; });
  awardForm.elements.strike_price.required = isOption;
  if (!isOption) {
    awardForm.elements.expiration_date.value = '';
    awardForm.elements.strike_price.value = '0';
  }
  updateLiveSummary();
}

function showForm() {
  awardFormCard.hidden = false;
  document.querySelector('#openAwardForm').hidden = true;
  awardFormCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function hideForm() {
  awardFormCard.hidden = true;
  document.querySelector('#openAwardForm').hidden = false;
  formMessage.textContent = '';
}
function resetAwardForm() {
  editingAwardId = null;
  awardForm.reset();
  vestingEvents.innerHTML = '';
  toggleOptionFields();
  updateScheduleBuilder();
  updateLiveSummary();
  document.querySelector('#awardFormTitle').textContent = 'Add equity award';
  document.querySelector('#awardSubmitButton').textContent = 'Save award';
}

function renderAwards(awards) {
  savedAwards = awards;
  document.querySelector('#awardCount').textContent = awards.length;
  document.querySelector('#totalGranted').textContent = formatNumber(awards.reduce((sum, award) => sum + award.shares_granted, 0));
  document.querySelector('#totalVested').textContent = formatNumber(awards.reduce((sum, award) => sum + award.shares_vested, 0));
  if (!awards.length) {
    awardsList.innerHTML = '<div class="empty-state"><h2>No equity awards yet</h2><p>Add your first award to begin tracking it.</p></div>';
    return;
  }
  awardsList.innerHTML = awards.map((award) => {
    const percent = award.shares_granted ? Math.min(100, award.shares_vested / award.shares_granted * 100) : 0;
    const scheduleRows = award.vesting_events.length ? award.vesting_events.map((event) => {
      const vested = event.vest_date <= asOfInput.value;
      const canSettle = award.award_type === 'RSU' && event.vest_date <= new Date().toISOString().slice(0, 10);
      return `<tr><td>${formatDate(event.vest_date)}</td><td>${formatNumber(event.shares)}</td><td>${event.settled ? 'Settled' : vested ? 'Vested' : 'Scheduled'}</td><td>${canSettle && !event.settled ? `<button class="secondary-button" type="button" data-settle="${event.id}">Create acquisition lot</button>` : event.settled ? 'Lot created' : '—'}</td></tr>`;
    }).join('') : '<tr><td colspan="4">No structured vesting events</td></tr>';
    return `
      <article class="award-card" data-award-id="${award.id}">
        <div class="award-title">
          <div><h2>${text(award.company)}</h2><p>${text(award.security)}${award.grant_number ? ` · Grant ${text(award.grant_number)}` : ''}</p></div>
          <div class="award-actions"><span class="type-badge">${text(awardNames[award.award_type] || award.award_type)}</span><button type="button" data-edit="${award.id}">Edit</button><button class="delete-button" type="button" data-delete="${award.id}">Delete</button></div>
        </div>
        <div class="award-details">
          <div><span>Grant date</span><strong>${formatDate(award.grant_date)}</strong></div>
          <div><span>Expiration</span><strong>${award.award_type === 'RSU' ? 'Not applicable' : formatDate(award.expiration_date)}</strong></div>
          <div><span>Strike price</span><strong>${award.award_type === 'RSU' ? 'Not applicable' : formatMoney(award.strike_price)}</strong></div>
          <div><span>QSBS status</span><strong>${text(award.qsbs_status)}</strong></div>
        </div>
        <div class="vesting-progress">
          <div><span>${formatNumber(award.shares_vested)} vested · ${formatNumber(award.shares_unvested)} unvested</span><span>${formatNumber(award.shares_granted)} granted</span></div>
          <i><b style="width:${percent}%"></b></i>
        </div>
        <div class="award-share-status">
          <div><span>Vested</span><strong>${formatNumber(award.shares_vested)}</strong></div>
          <div><span>Unvested</span><strong>${formatNumber(award.shares_unvested)}</strong></div>
          <div><span>Exercised</span><strong>${formatNumber(award.shares_exercised)}</strong></div>
          <div><span>Sold</span><strong>${formatNumber(award.shares_sold)}</strong></div>
          <div><span>Canceled</span><strong>${formatNumber(award.shares_canceled)}</strong></div>
          <div><span>Available</span><strong>${formatNumber(award.shares_available)}</strong></div>
        </div>
        <section class="award-schedule">
          <div class="award-schedule-heading">
            <div><strong>Vesting schedule</strong><small>${text(award.vesting_schedule || `${award.vesting_events.length} custom events`)}</small></div>
            <button class="secondary-button" type="button" data-schedule-toggle aria-expanded="false">Expand schedule</button>
          </div>
          <div class="award-schedule-content" data-schedule-content hidden>
            <div class="award-schedule-table"><table><thead><tr><th>Date</th><th>Shares</th><th>Status</th><th>RSU settlement</th></tr></thead><tbody>${scheduleRows}</tbody></table></div>
          </div>
        </section>
        <div class="award-notes">
          ${award.notes ? `<p><strong>Notes:</strong> ${text(award.notes)}</p>` : ''}
          <p><strong>QSBS acquisition:</strong> ${text(award.acquisition_details || 'Not provided')}${award.acquisition_date ? ` (${formatDate(award.acquisition_date)})` : ''}</p>
        </div>
      </article>`;
  }).join('');
  const linkedAwardId = Number(new URLSearchParams(window.location.search).get('award_id'));
  if (linkedAwardId) {
    const linkedCard = awardsList.querySelector(`[data-award-id="${linkedAwardId}"]`);
    if (linkedCard) {
      linkedCard.classList.add('linked-award-highlight');
      window.requestAnimationFrame(() => linkedCard.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }
  }
}

async function loadAwards() {
  try {
    const response = await fetch(`/api/awards?as_of=${encodeURIComponent(asOfInput.value)}`);
    if (!response.ok) throw new Error('Could not load awards');
    renderAwards(await response.json());
  } catch (error) {
    awardsList.innerHTML = `<div class="empty-state"><h2>Could not load awards</h2><p>${text(error.message)}</p></div>`;
  }
}

awardForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  formMessage.textContent = 'Saving...';
  const values = Object.fromEntries(new FormData(awardForm));
  values.shares_vested = '0';
  values.vesting_events = [...vestingEvents.querySelectorAll('.vesting-event-row')].map((row) => ({
    vest_date: row.querySelector('[data-vest-date]').value,
    shares: row.querySelector('[data-vest-shares]').value,
  }));
  try {
    const response = await fetch(editingAwardId ? `/api/awards/${editingAwardId}` : '/api/awards', {
      method: editingAwardId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save award');
    showToast(editingAwardId ? 'Award updated' : 'Award saved');
    resetAwardForm();
    hideForm();
    await loadAwards();
  } catch (error) { formMessage.textContent = error.message; }
});

function editAward(id) {
  const award = savedAwards.find((item) => item.id === id);
  if (!award) return;
  editingAwardId = id;
  Object.entries(award).forEach(([name, value]) => {
    const field = awardForm.elements.namedItem(name);
    if (field) field.value = value ?? '';
  });
  vestingEvents.innerHTML = '';
  award.vesting_events.forEach(addVestingEvent);
  toggleOptionFields();
  updateScheduleBuilder();
  updateLiveSummary();
  document.querySelector('#awardFormTitle').textContent = 'Edit equity award';
  document.querySelector('#awardSubmitButton').textContent = 'Update award';
  showForm();
}

async function deleteAward(id) {
  const award = savedAwards.find((item) => item.id === id);
  if (!award || !window.confirm(`Delete the ${awardNames[award.award_type] || award.award_type} award from ${award.company}?`)) return;
  const response = await fetch(`/api/awards/${id}`, { method: 'DELETE' });
  const result = await response.json();
  if (!response.ok) { window.alert(result.error || 'Could not delete award'); return; }
  if (editingAwardId === id) { resetAwardForm(); hideForm(); }
  showToast('Award deleted');
  await loadAwards();
}

awardsList.addEventListener('click', (event) => {
  const editButton = event.target.closest('[data-edit]');
  const deleteButton = event.target.closest('[data-delete]');
  if (editButton) editAward(Number(editButton.dataset.edit));
  if (deleteButton) deleteAward(Number(deleteButton.dataset.delete));
  const settleButton = event.target.closest('[data-settle]');
  if (settleButton) settleVestingEvent(Number(settleButton.dataset.settle));
  const scheduleButton = event.target.closest('[data-schedule-toggle]');
  if (scheduleButton) {
    const content = scheduleButton.closest('.award-schedule').querySelector('[data-schedule-content]');
    const expanded = scheduleButton.getAttribute('aria-expanded') !== 'true';
    scheduleButton.setAttribute('aria-expanded', String(expanded));
    scheduleButton.textContent = expanded ? 'Collapse schedule' : 'Expand schedule';
    content.hidden = !expanded;
  }
});
async function settleVestingEvent(eventId) {
  const entered = window.prompt('Enter the fair market value per share on the settlement date:');
  if (entered === null) return;
  const fmv = Number(entered);
  if (!Number.isFinite(fmv) || fmv < 0) { window.alert('Enter a valid nonnegative FMV.'); return; }
  const response = await fetch(`/api/vesting-events/${eventId}/settle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fmv }),
  });
  const result = await response.json();
  if (!response.ok) { window.alert(result.error || 'Could not create acquisition lot'); return; }
  showToast('RSU acquisition lot created');
  await loadAwards();
}
vestingEvents.addEventListener('click', (event) => {
  const button = event.target.closest('.remove-vesting-event');
  if (button) { button.closest('.vesting-event-row').remove(); updateLiveSummary(); }
});
document.querySelector('#addVestingEvent').addEventListener('click', () => { addVestingEvent(); updateLiveSummary(); });
document.querySelector('#scheduleType').addEventListener('change', updateScheduleBuilder);
['scheduleStart', 'scheduleDuration', 'scheduleCliff'].forEach((id) => document.querySelector(`#${id}`).addEventListener('input', updateSchedule));
awardForm.elements.shares_granted.addEventListener('input', updateSchedule);
awardForm.elements.shares_canceled.addEventListener('input', updateLiveSummary);
vestingEvents.addEventListener('input', updateLiveSummary);
document.querySelector('#awardType').addEventListener('change', toggleOptionFields);
document.querySelector('#openAwardForm').addEventListener('click', () => { resetAwardForm(); showForm(); });
document.querySelector('#closeAwardForm').addEventListener('click', () => { resetAwardForm(); hideForm(); });
asOfInput.value = new Date().toISOString().slice(0, 10);
asOfInput.addEventListener('change', () => { updateLiveSummary(); loadAwards(); });
resetAwardForm();
loadAwards();
