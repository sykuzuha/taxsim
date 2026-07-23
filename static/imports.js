const fileInput = document.querySelector('#portfolioCsv');
const importButton = document.querySelector('#uploadPortfolio');
const importMessage = document.querySelector('#importMessage');
const importsBody = document.querySelector('#importsBody');
const toast = document.querySelector('#importToast');

function safe(value) { const element = document.createElement('span'); element.textContent = value; return element.innerHTML; }
function showToast(value) { toast.textContent = value; toast.classList.add('show'); window.setTimeout(() => toast.classList.remove('show'), 2400); }
function importDate(value) { const parsed = new Date(`${value.replace(' ', 'T')}Z`); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(); }

function renderImports(imports) {
  importsBody.innerHTML = imports.length ? imports.map((item) => `<tr><td><strong>${safe(item.filename)}</strong></td><td>${safe(importDate(item.imported_at))}</td><td>${item.awards_imported}</td><td>${item.transactions_imported}</td></tr>`).join('') : '<tr><td colspan="4" class="table-empty">No CSV files have been imported yet.</td></tr>';
}

async function loadImports() {
  try {
    const response = await fetch('/api/imports');
    if (!response.ok) throw new Error('Could not load import history');
    renderImports(await response.json());
  } catch (error) { importsBody.innerHTML = `<tr><td colspan="4" class="table-empty">${safe(error.message)}</td></tr>`; }
}

importButton.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) { importMessage.textContent = 'Choose a CSV file first.'; return; }
  importButton.disabled = true;
  importMessage.textContent = 'Importing and rebuilding lot inventory...';
  const body = new FormData(); body.append('file', file);
  try {
    const response = await fetch('/api/portfolio/import', { method: 'POST', body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not import portfolio');
    importMessage.textContent = result.message;
    fileInput.value = '';
    showToast('Portfolio imported');
    await loadImports();
  } catch (error) { importMessage.textContent = error.message; }
  importButton.disabled = false;
});

document.querySelector('#refreshImports').addEventListener('click', loadImports);
loadImports();
