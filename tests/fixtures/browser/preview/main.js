window.previewDocument ??= crypto.randomUUID();
document.querySelector("#status").textContent = "Initial";
if (import.meta.hot) import.meta.hot.accept();
