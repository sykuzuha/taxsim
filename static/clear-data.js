document.querySelectorAll('[data-clear-page]').forEach((button) => {
  button.addEventListener('click', async () => {
    const label = button.dataset.clearLabel || 'this page';
    const extra = button.dataset.clearMessage ? `\n\n${button.dataset.clearMessage}` : '';
    if (!window.confirm(`Permanently clear all data for ${label}? This cannot be undone.${extra}`)) return;
    button.disabled = true;
    const original = button.textContent;
    button.textContent = 'Clearing…';
    try {
      const response = await fetch(`/api/clear/${button.dataset.clearPage}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not clear data');
      window.location.reload();
    } catch (error) {
      window.alert(error.message);
      button.disabled = false;
      button.textContent = original;
    }
  });
});
