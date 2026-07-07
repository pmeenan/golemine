(() => {
  try {
    const theme = localStorage.getItem("golemine-theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }
  } catch {
    /* localStorage may be unavailable under strict privacy settings. */
  }
})();
