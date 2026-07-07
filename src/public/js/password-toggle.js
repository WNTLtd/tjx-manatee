document.addEventListener("DOMContentLoaded", () => {
  const buttons = document.querySelectorAll(".toggle-password[data-target]");

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const targetId = button.getAttribute("data-target");
      const input = document.getElementById(targetId);
      if (!input) return;

      const isHidden = input.type === "password";
      input.type = isHidden ? "text" : "password";
      button.textContent = isHidden ? "Hide" : "Show";
    });
  }
});
