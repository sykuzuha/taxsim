const formCard = document.querySelector('#exerciseFormCard');
const form = document.querySelector('#exerciseForm');
const awardSelect = document.querySelector('#exerciseAward');
const list = document.querySelector('#exerciseList');
const message = document.querySelector('#exerciseMessage');
const toast = document.querySelector('#exerciseToast');
let awards = [];
let exercises = [];
let editingExerciseId = null;
let estimateTimer = null;

function safe(value) { const element = document.createElement('span'); element.textContent = value; return element.innerHTML; }
function number(value) { return Number(value || 0).toLocaleString(); }
function money(value) { return Number(value || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' }); }
function date(value) { return value ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'; }
function showToast(value) { toast.textContent = value; toast.classList.add('show'); window.setTimeout(() => toast.classList.remove('show'), 2200); }
function showForm() { formCard.hidden = false; document.querySelector('#openExerciseForm').hidden = true; formCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function hideForm() { formCard.hidden = true; document.querySelector('#openExerciseForm').hidden = false; message.textContent = ''; }
function resetForm() {
  editingExerciseId = null;
  form.reset();
  document.querySelector('#exerciseFormTitle').textContent = 'Add exercise';
  document.querySelector('#exerciseSubmit').textContent = 'Save exercise';
  clearEstimate();
}

function clearEstimate(description = 'Complete the exercise details to compare regular tax and AMT.') {
  document.querySelector('#estimateDescription').textContent = description;
  ['estimateSpread', 'estimateRegularTax', 'estimateAmt', 'estimateCash'].forEach((id) => { document.querySelector(`#${id}`).textContent = '—'; });
  document.querySelector('#estimateRegularDetail').textContent = 'Federal + state';
  document.querySelector('#estimateBreakdown').hidden = true;
}

async function updateTaxEstimate() {
  const values = Object.fromEntries(new FormData(form));
  if (!values.award_id || !values.exercise_date || Number(values.shares) <= 0 || values.fmv === '' || values.exercise_price === '') {
    clearEstimate();
    return;
  }
  values.exercise_id = editingExerciseId;
  document.querySelector('#estimateDescription').textContent = 'Calculating…';
  try {
    const response = await fetch('/api/exercises/estimate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not estimate tax');
    document.querySelector('#estimateSpread').textContent = money(result.spread);
    document.querySelector('#estimateRegularTax').textContent = money(result.non_amt_tax);
    document.querySelector('#estimateAmt').textContent = money(result.amt_tax);
    document.querySelector('#estimateCash').textContent = money(result.estimated_cash_required);
    document.querySelector('#estimateRegularDetail').textContent = `${money(result.regular_federal_tax)} federal · ${money(result.state_tax)} state`;
    document.querySelector('#estimateDescription').textContent = result.award_type === 'ISO'
      ? `ISO exercise · ${result.tax_year} · spread is an AMT adjustment, not regular compensation income.`
      : `NSO exercise · ${result.tax_year} · spread is estimated as ordinary compensation income.`;
    const breakdown = document.querySelector('#estimateBreakdown');
    breakdown.hidden = false;
    breakdown.innerHTML = result.award_type === 'ISO'
      ? `<span>Regular compensation income <strong>${money(result.compensation_income)}</strong></span><span>AMT adjustment <strong>${money(result.amt_adjustment)}</strong></span>`
      : `<span>Compensation income <strong>${money(result.compensation_income)}</strong></span><span>AMT adjustment <strong>${money(result.amt_adjustment)}</strong></span>`;
    if (!result.profile_found) document.querySelector('#estimateDescription').textContent += ' Add a saved tax profile for a more complete estimate.';
  } catch (error) {
    clearEstimate(error.message);
  }
}

function scheduleTaxEstimate() {
  window.clearTimeout(estimateTimer);
  estimateTimer = window.setTimeout(updateTaxEstimate, 250);
}

function renderAwards() {
  awardSelect.innerHTML = '<option value="">Select an option award</option>' + awards.filter((award) => award.award_type !== 'RSU').map((award) =>
    `<option value="${award.id}">${safe(award.company)} · ${safe(award.award_type)}${award.grant_number ? ` · Grant ${safe(award.grant_number)}` : ''} · ${date(award.grant_date)}</option>`
  ).join('');
}

function renderExercises(exercises) {
  document.querySelector('#exerciseCount').textContent = exercises.length;
  document.querySelector('#exerciseShares').textContent = number(exercises.reduce((sum, item) => sum + item.shares, 0));
  document.querySelector('#exerciseCost').textContent = money(exercises.reduce((sum, item) => sum + item.shares * item.exercise_price, 0));
  list.innerHTML = exercises.length ? exercises.map((item) => `
    <article class="transaction-card">
      <div class="transaction-heading">
        <div><h2>${safe(item.company)} · ${safe(item.award_type)}${item.grant_number ? ` · Grant ${safe(item.grant_number)}` : ''}</h2><p>${date(item.exercise_date)} · Award granted ${date(item.grant_date)}</p></div>
        <div class="transaction-actions"><button class="edit-transaction" type="button" data-edit="${item.id}">Edit</button><button type="button" data-delete="${item.id}">Delete</button></div>
      </div>
      <div class="transaction-details">
        <div><span>Shares</span><strong>${number(item.shares)}</strong></div>
        <div><span>FMV / share</span><strong>${money(item.fmv)}</strong></div>
        <div><span>Exercise price / share</span><strong>${money(item.exercise_price)}</strong></div>
        <div><span>Total exercise cost</span><strong>${money(item.shares * item.exercise_price)}</strong></div>
      </div>
    </article>`).join('') : '<div class="empty-state"><h2>No exercises yet</h2><p>Add an exercise after creating an equity award.</p></div>';
}

function editExercise(id) {
  const exercise = exercises.find((item) => item.id === Number(id));
  if (!exercise) return false;
  editingExerciseId = exercise.id;
  form.elements.award_id.value = exercise.award_id;
  form.elements.exercise_date.value = exercise.exercise_date;
  form.elements.shares.value = exercise.shares;
  form.elements.fmv.value = exercise.fmv;
  form.elements.exercise_price.value = exercise.exercise_price;
  document.querySelector('#exerciseFormTitle').textContent = 'Edit exercise';
  document.querySelector('#exerciseSubmit').textContent = 'Update exercise';
  showForm();
  updateTaxEstimate();
  return true;
}

async function loadPage() {
  try {
    const [awardResponse, exerciseResponse] = await Promise.all([fetch('/api/awards'), fetch('/api/exercises')]);
    if (!awardResponse.ok || !exerciseResponse.ok) throw new Error('Could not load exercises');
    awards = await awardResponse.json();
    exercises = await exerciseResponse.json();
    renderAwards();
    renderExercises(exercises);
  } catch (error) {
    list.innerHTML = `<div class="empty-state"><h2>Could not load exercises</h2><p>${safe(error.message)}</p></div>`;
  }
}

awardSelect.addEventListener('change', () => {
  const award = awards.find((item) => item.id === Number(awardSelect.value));
  if (award) form.elements.exercise_price.value = award.strike_price;
  scheduleTaxEstimate();
});
form.addEventListener('input', scheduleTaxEstimate);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = 'Saving…';
  const response = await fetch(editingExerciseId ? `/api/exercises/${editingExerciseId}` : '/api/exercises', {
    method: editingExerciseId ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(new FormData(form))),
  });
  const result = await response.json();
  if (!response.ok) { message.textContent = result.error || 'Could not save exercise'; return; }
  const wasEditing = Boolean(editingExerciseId);
  resetForm();
  hideForm();
  showToast(wasEditing ? 'Exercise updated' : 'Exercise saved');
  await loadPage();
});
list.addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit]');
  if (editButton) {
    editExercise(editButton.dataset.edit);
    return;
  }
  const button = event.target.closest('[data-delete]');
  if (!button || !window.confirm('Delete this exercise?')) return;
  const response = await fetch(`/api/exercises/${button.dataset.delete}`, { method: 'DELETE' });
  const result = await response.json();
  if (!response.ok) { window.alert(result.error || 'Could not delete exercise'); return; }
  showToast('Exercise deleted');
  await loadPage();
});
document.querySelector('#openExerciseForm').addEventListener('click', () => { resetForm(); showForm(); });
document.querySelector('#closeExerciseForm').addEventListener('click', () => { resetForm(); hideForm(); });
loadPage().then(() => {
  const editId = Number(new URLSearchParams(window.location.search).get('edit_id'));
  if (editId && editExercise(editId)) return;
  const awardId = Number(new URLSearchParams(window.location.search).get('award_id'));
  if (awardId && awards.some((award) => award.id === awardId && award.award_type !== 'RSU')) {
    resetForm();
    awardSelect.value = awardId;
    const award = awards.find((item) => item.id === awardId);
    form.elements.exercise_price.value = award.strike_price;
    showForm();
    updateTaxEstimate();
  }
});
