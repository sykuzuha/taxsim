const form = document.querySelector('#profileForm');
const toast = document.querySelector('#toast');
const status = document.querySelector('#saveStatus');
const defaultValues = Object.fromEntries(new FormData(form));

function selectedDeductionType() {
  return document.querySelector('[data-deduction].selected').dataset.deduction;
}

async function saveProfile() {
  const values = Object.fromEntries(new FormData(form));
  values.deduction_type = selectedDeductionType();
  status.innerHTML = '<i style="background:#d59b44"></i> Saving...';

  try {
    const response = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save profile');
    status.innerHTML = '<i></i> All changes saved';
    toast.textContent = 'Profile saved';
  } catch (error) {
    status.innerHTML = '<i style="background:#dc2626"></i> Save failed';
    toast.textContent = error.message;
  }

  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 2200);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  saveProfile();
});

form.addEventListener('input', () => { status.innerHTML = '<i style="background:#d59b44"></i> Unsaved changes'; });

document.querySelectorAll('[data-deduction]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-deduction]').forEach((item) => item.classList.remove('selected'));
    button.classList.add('selected');
    document.querySelector('#itemizedField').classList.toggle('visible', button.dataset.deduction === 'itemized');
    status.innerHTML = '<i style="background:#d59b44"></i> Unsaved changes';
  });
});

function setDeductionType(type = 'standard') {
  document.querySelectorAll('[data-deduction]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.deduction === type);
  });
  document.querySelector('#itemizedField').classList.toggle('visible', type === 'itemized');
}

async function loadProfile(taxYear) {
  try {
    const response = await fetch(`/api/profile/${taxYear}`);
    if (!response.ok) throw new Error('Could not load profile');
    const values = await response.json();
    if (!values) {
      Object.entries(defaultValues).forEach(([name, value]) => {
        const field = form.elements.namedItem(name);
        if (field && name !== 'tax_year') field.value = value;
      });
      setDeductionType('standard');
      status.innerHTML = '<i></i> No saved profile for this year';
      return;
    }

    Object.entries(values).forEach(([name, value]) => {
      const field = form.elements.namedItem(name);
      if (field && name !== 'tax_year') field.value = value;
    });
    setDeductionType(values.deduction_type);
    status.innerHTML = '<i></i> Profile loaded';
  } catch (error) {
    status.innerHTML = '<i style="background:#dc2626"></i> Load failed';
  }
}

const taxYearField = form.elements.namedItem('tax_year');
taxYearField.addEventListener('change', () => loadProfile(taxYearField.value));
loadProfile(taxYearField.value);
