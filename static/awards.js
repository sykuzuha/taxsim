const awardFormCard = document.querySelector('#awardFormCard');
const awardForm = document.querySelector('#awardForm');
const awardsList = document.querySelector('#awardsList');
const formMessage = document.querySelector('#formMessage');
const toast = document.querySelector('#toast');
let savedAwards = [];
let editingAwardId = null;

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
  document.querySelector('#awardFormTitle').textContent = 'Add equity award';
  document.querySelector('#awardSubmitButton').textContent = 'Save award';
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function formatDate(value) {
  if (!value) return 'Not provided';
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function text(value) {
  const element = document.createElement('span');
  element.textContent = value;
  return element.innerHTML;
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
    const percent = award.shares_granted ? Math.min(100, (award.shares_vested / award.shares_granted) * 100) : 0;
    return `
      <article class="award-card">
        <div class="award-title"><div><h2>${text(award.company)}</h2><p>${text(award.security)}</p></div><div class="award-actions"><span class="type-badge">${text(award.award_type)}</span><button type="button" data-edit="${award.id}">Edit</button><button class="delete-button" type="button" data-delete="${award.id}">Delete</button></div></div>
        <div class="award-details">
          <div><span>Grant date</span><strong>${formatDate(award.grant_date)}</strong></div>
          <div><span>Expiration</span><strong>${formatDate(award.expiration_date)}</strong></div>
          <div><span>Strike price</span><strong>${formatMoney(award.strike_price)}</strong></div>
          <div><span>QSBS status</span><strong>${text(award.qsbs_status)}</strong></div>
        </div>
        <div class="vesting-progress"><div><span>${formatNumber(award.shares_vested)} vested</span><span>${formatNumber(award.shares_granted)} granted</span></div><i><b style="width:${percent}%"></b></i></div>
        <div class="award-notes"><p><strong>Vesting:</strong> ${text(award.vesting_schedule || 'Not provided')}</p><p><strong>Acquisition:</strong> ${text(award.acquisition_details || 'Not provided')}${award.acquisition_date ? ` (${formatDate(award.acquisition_date)})` : ''}</p></div>
      </article>`;
  }).join('');
}

async function loadAwards() {
  try {
    const response = await fetch('/api/awards');
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
  try {
    const url = editingAwardId ? `/api/awards/${editingAwardId}` : '/api/awards';
    const method = editingAwardId ? 'PUT' : 'POST';
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save award');
    const successMessage = editingAwardId ? 'Award updated' : 'Award saved';
    resetAwardForm();
    hideForm();
    toast.textContent = successMessage;
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 2200);
    await loadAwards();
  } catch (error) {
    formMessage.textContent = error.message;
  }
});

function editAward(id) {
  const award = savedAwards.find((item) => item.id === id);
  if (!award) return;
  editingAwardId = id;
  Object.entries(award).forEach(([name, value]) => {
    const field = awardForm.elements.namedItem(name);
    if (field) field.value = value ?? '';
  });
  document.querySelector('#awardFormTitle').textContent = 'Edit equity award';
  document.querySelector('#awardSubmitButton').textContent = 'Update award';
  showForm();
}

async function deleteAward(id) {
  const award = savedAwards.find((item) => item.id === id);
  if (!award || !window.confirm(`Delete the ${award.award_type} award from ${award.company}?`)) return;
  try {
    const response = await fetch(`/api/awards/${id}`, { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not delete award');
    if (editingAwardId === id) { resetAwardForm(); hideForm(); }
    toast.textContent = 'Award deleted';
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 2200);
    await loadAwards();
  } catch (error) {
    window.alert(error.message);
  }
}

awardsList.addEventListener('click', (event) => {
  const editButton = event.target.closest('[data-edit]');
  const deleteButton = event.target.closest('[data-delete]');
  if (editButton) editAward(Number(editButton.dataset.edit));
  if (deleteButton) deleteAward(Number(deleteButton.dataset.delete));
});

document.querySelector('#openAwardForm').addEventListener('click', () => { resetAwardForm(); showForm(); });
document.querySelector('#closeAwardForm').addEventListener('click', () => { resetAwardForm(); hideForm(); });
loadAwards();
