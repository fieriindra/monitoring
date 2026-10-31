fetch("/api/me", { credentials: "same-origin" })
  .then((response) => {
    if (!response.ok) throw new Error("Sesi tidak valid.");
    return response.json();
  })
  .then((user) => {
    document.querySelectorAll("[data-username]").forEach((element) => {
      element.textContent = user.username;
    });
  })
  .catch(() => {
    window.location.replace("/");
  });

document.querySelectorAll("[data-logout]").forEach((button) => {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const response = await fetch("/api/logout", {
        method: "POST",
        credentials: "same-origin"
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Gagal keluar.");
      window.location.assign(result.redirect);
    } catch (error) {
      button.disabled = false;
      const message = document.querySelector("[data-message]");
      if (message) message.textContent = error.message;
    }
  });
});
