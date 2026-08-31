(() => {
  "use strict";

  const telegram = window.Telegram?.WebApp;
  const screens = [...document.querySelectorAll("[data-screen]")];
  const navButtons = [...document.querySelectorAll(".nav-button")];
  const screenLinks = [...document.querySelectorAll("[data-screen-link]")];
  const form = document.getElementById("exchange-form");
  const amountInput = document.getElementById("give-amount");
  const amountError = document.getElementById("amount-error");
  const giveCurrency = document.getElementById("give-currency");
  const receiveCurrency = document.getElementById("receive-currency");
  const swapButton = document.getElementById("swap-button");
  const sheet = document.getElementById("request-sheet");
  const toast = document.getElementById("toast");
  const copyButton = document.getElementById("copy-request");
  let currentDraft = null;
  let toastTimer = null;

  const tap = (style = "light") => {
    telegram?.HapticFeedback?.impactOccurred(style);
  };

  const notify = (message) => {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2200);
  };

  const showScreen = (screenName) => {
    screens.forEach((screen) => {
      screen.classList.toggle("is-active", screen.dataset.screen === screenName);
    });

    navButtons.forEach((button) => {
      const isActive = button.dataset.screenLink === screenName;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-current", isActive ? "page" : "false");
    });

    window.scrollTo({ top: 0, behavior: "smooth" });
    tap();
  };

  const parseAmount = (value) => {
    const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
    if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
    const amount = Number(normalized);
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  };

  const formatTypedAmount = (value) => value.trim().replace(/\s/g, "").replace(".", ",");

  const createDraftText = (draft) => [
    "Заявка Papakha Exchange",
    `Отдаю: ${draft.amount} ${draft.giveCurrency}`,
    `Получаю: ${draft.receiveCurrency}`,
    `Способ расчёта: ${draft.method}`,
    "Курс и итоговая сумма: после подтверждения",
  ].join("\n");

  const openSheet = (draft) => {
    currentDraft = draft;
    document.getElementById("summary-give").textContent = `${draft.amount} ${draft.giveCurrency}`;
    document.getElementById("summary-receive").textContent = draft.receiveCurrency;
    document.getElementById("summary-method").textContent = draft.method;
    sheet.classList.add("is-open");
    sheet.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    telegram?.HapticFeedback?.notificationOccurred("success");
    window.setTimeout(() => copyButton.focus(), 230);
  };

  const closeSheet = () => {
    sheet.classList.remove("is-open");
    sheet.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    amountInput.focus();
    tap();
  };

  const initTelegram = () => {
    if (!telegram) return;
    telegram.ready();
    telegram.expand();
    const supportsCustomColors = telegram.isVersionAtLeast?.("6.9");
    if (supportsCustomColors) {
      telegram.setHeaderColor?.("#b60024");
      telegram.setBackgroundColor?.("#ffffff");
    }

    if (telegram.colorScheme === "dark") {
      document.body.classList.add("theme-dark");
      if (supportsCustomColors) telegram.setBackgroundColor?.("#171717");
    }

    telegram.onEvent?.("themeChanged", () => {
      const isDark = telegram.colorScheme === "dark";
      document.body.classList.toggle("theme-dark", isDark);
      if (supportsCustomColors) {
        telegram.setBackgroundColor?.(isDark ? "#171717" : "#ffffff");
      }
    });
  };

  screenLinks.forEach((button) => {
    button.addEventListener("click", () => showScreen(button.dataset.screenLink));
  });

  swapButton.addEventListener("click", () => {
    const previousGive = giveCurrency.value;
    const previousReceive = receiveCurrency.value;
    giveCurrency.value = previousReceive;
    receiveCurrency.value = previousGive;
    tap("medium");
  });

  amountInput.addEventListener("input", () => {
    amountError.textContent = "";
    amountInput.removeAttribute("aria-invalid");
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const amount = parseAmount(amountInput.value);

    if (!amount) {
      amountError.textContent = "Введите сумму больше нуля";
      amountInput.setAttribute("aria-invalid", "true");
      amountInput.focus();
      telegram?.HapticFeedback?.notificationOccurred("error");
      return;
    }

    if (giveCurrency.value === receiveCurrency.value) {
      amountError.textContent = "Выберите разные валюты";
      telegram?.HapticFeedback?.notificationOccurred("error");
      return;
    }

    const method = new FormData(form).get("method");
    const draft = {
      amount: formatTypedAmount(amountInput.value),
      giveCurrency: giveCurrency.value,
      receiveCurrency: receiveCurrency.value,
      method,
    };

    try {
      window.localStorage.setItem("papakhaExchangeDraft", JSON.stringify(draft));
    } catch {
      // The app remains fully usable when device storage is unavailable.
    }

    openSheet(draft);
  });

  document.querySelectorAll("[data-close-sheet]").forEach((button) => {
    button.addEventListener("click", closeSheet);
  });

  copyButton.addEventListener("click", async () => {
    if (!currentDraft) return;
    const requestText = createDraftText(currentDraft);

    try {
      await navigator.clipboard.writeText(requestText);
      notify("Заявка скопирована");
      telegram?.HapticFeedback?.notificationOccurred("success");
    } catch {
      notify("Не удалось скопировать автоматически");
      telegram?.HapticFeedback?.notificationOccurred("error");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sheet.classList.contains("is-open")) closeSheet();
  });

  try {
    const savedDraft = JSON.parse(window.localStorage.getItem("papakhaExchangeDraft"));
    if (savedDraft?.amount && savedDraft?.giveCurrency && savedDraft?.receiveCurrency) {
      amountInput.value = savedDraft.amount;
      giveCurrency.value = savedDraft.giveCurrency;
      receiveCurrency.value = savedDraft.receiveCurrency;
      const methodInput = form.querySelector(`input[name="method"][value="${savedDraft.method}"]`);
      if (methodInput) methodInput.checked = true;
    }
  } catch {
    // Ignore invalid or unavailable local storage.
  }

  initTelegram();
})();
