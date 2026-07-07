(() => {
  const forms = document.querySelectorAll(".item-edit-form");
  if (!forms.length) return;

  for (const form of forms) {
    const input = form.querySelector("input[name='name']");
    const saveButton = form.querySelector("button[type='submit']");
    if (!input || !saveButton) continue;

    const initialValue = input.value;

    const syncState = () => {
      const changed = input.value.trim() !== initialValue.trim();
      const empty = input.value.trim().length === 0;
      saveButton.disabled = !changed || empty;
    };

    input.addEventListener("input", syncState);
    input.addEventListener("change", syncState);
    syncState();
  }
})();
