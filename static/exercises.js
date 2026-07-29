const formCard = document.querySelector('#exerciseFormCard');
const form = document.querySelector('#exerciseForm');
const awardSelect = document.querySelector('#exerciseAward');
const list = document.querySelector('#exerciseList');
const message = document.querySelector('#exerciseMessage');
const toast = document.querySelector('#exerciseToast');
let awards = [];

function safe(value) { const element = document.createElement('span'); element.textContent = value; return element.innerHTML; }
function number(value) { return Number(value || 0).toLocaleString(); }
function money(value) { return Number(value || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' }); }
function date(value) { return value ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'; }
function showToast(value) { toast.textContent = value; toast.classList.add('show'); window.setTimeout(() => toast.classList.remove('show'), 2200); }
function showForm() { formCard.hidden = false; document.querySelector('#openExerciseForm').hidden = true; }
function hideForm() { formCard.hidden = true; document.querySelector('#openExerciseForm').hidden = false; message.textContent = ''; }

function renderAwards() {
  awardSelect.innerHTML = '<option value="">Select an option award</option>' + awards.filter((award) => award.award_type !== 'RSU').map((award) =>
    `<option value="${award.id}">${safe(award.company)} · ${safe(award.award_type)} · ${date(award.grant_date)}</option>`
  ).join('');
}

function renderExercises(exercises) {
  document.querySelector('#exerciseCount').textContent = exercises.length;
  document.querySelector('#exerciseShares').textContent = number(exercises.reduce((sum, item) => sum + item.shares, 0));
  document.querySelector('#exerciseCost').textContent = money(exercises.reduce((sum, item) => sum + item.shares * item.exercise_price, 0));
  list.innerHTML = exercises.length ? exercises.map((item) => `
    <article class="transaction-card">
      <div class="transaction-heading">
        <div><h2>${safe(item.company)} · ${safe(item.award_type)}</h2><p>${date(item.exercise_date)} · Award granted ${date(item.grant_date)}</p></div>
        <div class="transaction-actions"><button type="button" data-delete="${item.id}">Delete</button></div>
      </div>
      <div class="transaction-details">
        <div><span>Shares</span><strong>${number(item.shares)}</strong></div>
        <div><span>FMV / share</span><strong>${money(item.fmv)}</strong></div>
        <div><span>Exercise price / share</span><strong>${money(item.exercise_price)}</strong></div>
        <div><span>Total exercise cost</span><strong>${money(item.shares * item.exercise_price)}</strong></div>
      </div>
    </article>`).join('') : '<div class="empty-state"><h2>No exercises yet</h2><p>Add an exercise after creating an equity award.</p></div>';
}

async function loadPage() {
  try {
    const [awardResponse, exerciseResponse] = await Promise.all([fetch('/api/awards'), fetch('/api/exercises')]);
    if (!awardResponse.ok || !exerciseResponse.ok) throw new Error('Could not load exercises');
    awards = await awardResponse.json();
    renderAwards();
    renderExercises(await exerciseResponse.json());
  } catch (error) {
    list.innerHTML = `<div class="empty-state"><h2>Could not load exercises</h2><p>${safe(error.message)}</p></div>`;
  }
}

awardSelect.addEventListener('change', () => {
  const award = awards.find((item) => item.id === Number(awardSelect.value));
  if (award) form.elements.exercise_price.value = award.strike_price;
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = 'Saving…';
  const response = await fetch('/api/exercises', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(new FormData(form))),
  });
  const result = await response.json();
  if (!response.ok) { message.textContent = result.error || 'Could not save exercise'; return; }
  form.reset();
  hideForm();
  showToast('Exercise saved');
  await loadPage();
});
list.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete]');
  if (!button || !window.confirm('Delete this exercise?')) return;
  const response = await fetch(`/api/exercises/${button.dataset.delete}`, { method: 'DELETE' });
  const result = await response.json();
  if (!response.ok) { window.alert(result.error || 'Could not delete exercise'); return; }
  showToast('Exercise deleted');
  await loadPage();
});
document.querySelector('#openExerciseForm').addEventListener('click', showForm);
document.querySelector('#closeExerciseForm').addEventListener('click', () => { form.reset(); hideForm(); });
loadPage();
