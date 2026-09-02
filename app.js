(() => {
  "use strict";

  const telegram = window.Telegram?.WebApp;
  const rateCore = window.PapakhaRates;
  const apiBaseUrl = window.PAPAKHA_CONFIG?.apiBaseUrl?.replace(/\/$/, "") || "";
  const ratesApiUrl = `${apiBaseUrl}/rates`;
  const screens = [...document.querySelectorAll("[data-screen]")];
  const navButtons = [...document.querySelectorAll(".nav-button")];
  const screenLinks = [...document.querySelectorAll("[data-screen-link]")];
  const form = document.getElementById("exchange-form");
  const surveySteps = [...document.querySelectorAll("[data-survey-step]")];
  const surveyCounter = document.getElementById("survey-counter");
  const surveyTitle = document.getElementById("exchange-title");
  const surveyProgressBar = document.getElementById("survey-progress-bar");
  const surveyBack = document.getElementById("survey-back");
  const surveyNext = document.getElementById("survey-next");
  const surveyError = document.getElementById("survey-error");
  const amountInput = document.getElementById("give-amount");
  const amountError = document.getElementById("amount-error");
  const amountCurrency = document.getElementById("amount-currency");
  const sheet = document.getElementById("request-sheet");
  const toast = document.getElementById("toast");
  const copyButton = document.getElementById("copy-request");
  const sheetEyebrow = document.getElementById("sheet-eyebrow");
  const sheetTitle = document.getElementById("sheet-title");
  const sheetNote = document.getElementById("sheet-note");
  const dealState = document.getElementById("deal-state");
  const dealPublicId = document.getElementById("deal-public-id");
  const dealStatus = document.getElementById("deal-status");
  const clientDealActions = document.getElementById("client-deal-actions");
  const ratesGrid = document.getElementById("rates-grid");
  const ratesStatus = document.getElementById("rates-status");
  const ratesMeta = document.getElementById("rates-meta");
  const headerTime = document.getElementById("header-time");
  const quotePanel = document.getElementById("quote-panel");
  const quoteState = document.getElementById("quote-state");
  const quoteValue = document.getElementById("quote-value");
  const quoteRate = document.getElementById("quote-rate");
  let currentDraft = null;
  let currentDeal = null;
  let dealPollTimer = null;
  let currentRates = null;
  let currentQuote = null;
  let currentSurveyStep = 0;
  let toastTimer = null;
  let ratesRequest = null;

  const surveyHeadings = [
    "Что<br /><em>отдаёте?</em>",
    "Какая<br /><em>сумма?</em>",
    "Что хотите<br /><em>получить?</em>",
    "Как<br /><em>рассчитаться?</em>",
  ];

  const tap = (style = "light") => {
    telegram?.HapticFeedback?.impactOccurred(style);
  };

  const notify = (message) => {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2200);
  };

  const formatTimestamp = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "время неизвестно";
    return date.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const payloadIsStale = (payload) => {
    const updatedAt = new Date(payload?.updatedAt).getTime();
    return Boolean(payload?.stale || !Number.isFinite(updatedAt) || Date.now() - updatedAt > 120000);
  };

  const storeRates = (payload) => {
    try {
      window.localStorage.setItem("papakhaLastRates", JSON.stringify(payload));
    } catch {
      // A live response remains usable when device storage is unavailable.
    }
  };

  const readStoredRates = () => {
    try {
      const stored = JSON.parse(window.localStorage.getItem("papakhaLastRates"));
      if (rateCore.validatePayload(stored)) return { ...stored, stale: true };
    } catch {
      // Ignore invalid or unavailable local storage.
    }
    return null;
  };

  const renderRates = (payload, state = "fresh") => {
    const hasRates = rateCore.validatePayload(payload);
    ratesGrid.setAttribute("aria-busy", "false");

    if (!hasRates) {
      ratesStatus.dataset.state = "error";
      ratesStatus.textContent = "Курс временно недоступен";
      ratesMeta.textContent = "Курс временно недоступен. Расчёт появится после восстановления связи.";
      ["rate-usdt-sell", "rate-usdt-buy", "rate-btc", "rate-eth"].forEach((id) => {
        document.getElementById(id).textContent = "—";
      });
      updateQuote();
      return;
    }

    const stale = state === "stale" || payloadIsStale(payload);
    ratesStatus.dataset.state = stale ? "stale" : "fresh";
    ratesStatus.textContent = stale ? "Курс устарел" : "Актуально";
    document.getElementById("rate-usdt-sell").textContent = `${rateCore.formatNumber(payload.rates["USDT/RUB"].sellRate, 2)} ₽`;
    document.getElementById("rate-usdt-buy").textContent = `${rateCore.formatNumber(payload.rates["USDT/RUB"].buyRate, 2)} ₽`;
    document.getElementById("rate-btc").textContent = `${rateCore.formatNumber(payload.rates["BTC/USDT"].close, 2)} USDT`;
    document.getElementById("rate-eth").textContent = `${rateCore.formatNumber(payload.rates["ETH/USDT"].close, 2)} USDT`;
    ratesMeta.textContent = stale ? `Курс устарел · обновлено в ${formatTimestamp(payload.updatedAt)}` : `Обновлено в ${formatTimestamp(payload.updatedAt)}`;
    if (headerTime) headerTime.textContent = formatTimestamp(payload.updatedAt).slice(0, 5);
    updateQuote();
  };

  const loadRates = async () => {
    if (ratesRequest) return ratesRequest;

    ratesGrid.setAttribute("aria-busy", "true");
    ratesStatus.dataset.state = "loading";
    ratesStatus.textContent = "Обновляем";

    ratesRequest = (async () => {
      try {
        if (!ratesApiUrl) throw new Error("Rates API is not configured");
        const response = await fetch(ratesApiUrl, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`Rates API returned ${response.status}`);
        const payload = await response.json();
        if (!rateCore.validatePayload(payload)) throw new Error("Invalid rates payload");
        currentRates = { ...payload, stale: payloadIsStale(payload) };
        storeRates(currentRates);
        renderRates(currentRates, currentRates.stale ? "stale" : "fresh");
      } catch {
        currentRates = currentRates || readStoredRates();
        renderRates(currentRates, currentRates ? "stale" : "error");
      } finally {
        ratesRequest = null;
      }
    })();

    return ratesRequest;
  };

  const showScreen = (screenName, restartSurvey = false) => {
    if (screenName === "exchange" && restartSurvey) setSurveyStep(0);
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

  const selectedValue = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value || "";

  const updateReceiveChoices = () => {
    const give = selectedValue("giveCurrency");
    form.querySelectorAll('input[name="receiveCurrency"]').forEach((input) => {
      const unavailable = input.value === give;
      input.disabled = unavailable;
      input.closest("label").hidden = unavailable;
      if (unavailable && input.checked) input.checked = false;
    });
    amountCurrency.textContent = give || "—";
  };

  const setSurveyStep = (step) => {
    currentSurveyStep = Math.max(0, Math.min(step, surveySteps.length - 1));
    surveySteps.forEach((item, index) => item.classList.toggle("is-active", index === currentSurveyStep));
    surveyCounter.textContent = `ШАГ ${currentSurveyStep + 1} ИЗ ${surveySteps.length}`;
    surveyTitle.innerHTML = surveyHeadings[currentSurveyStep];
    surveyProgressBar.style.width = `${((currentSurveyStep + 1) / surveySteps.length) * 100}%`;
    surveyBack.hidden = currentSurveyStep === 0;
    surveyNext.firstChild.textContent = currentSurveyStep === surveySteps.length - 1 ? "Создать заявку\n" : "Продолжить\n";
    surveyError.textContent = "";
    amountError.textContent = "";
    amountInput.removeAttribute("aria-invalid");
    updateReceiveChoices();
    updateQuote();
    window.scrollTo({ top: 0, behavior: "smooth" });
    tap();
    if (currentSurveyStep === 1) window.setTimeout(() => amountInput.focus(), 260);
  };

  const parseAmount = (value) => {
    const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
    if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
    const amount = Number(normalized);
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  };

  const formatTypedAmount = (value) => value.trim().replace(/\s/g, "").replace(".", ",");

  const updateQuote = () => {
    const amount = parseAmount(amountInput.value);
    const giveCurrency = selectedValue("giveCurrency");
    const receiveCurrency = selectedValue("receiveCurrency");
    currentQuote = amount && currentRates ? rateCore.calculateQuote({
      amount,
      giveCurrency,
      receiveCurrency,
      payload: currentRates,
    }) : null;

    quotePanel.classList.toggle("is-stale", Boolean(currentQuote?.stale));

    if (!currentQuote) {
      quoteState.textContent = currentRates ? "Курс после подтверждения" : "Курс недоступен";
      quoteValue.textContent = "—";
      quoteRate.textContent = ["KZT", "AED", "USD"].includes(giveCurrency) || ["KZT", "AED", "USD"].includes(receiveCurrency)
        ? "Для этого направления условия подтверждает менеджер"
        : "Выберите сумму и поддерживаемое направление";
      return;
    }

    const output = rateCore.formatNumber(currentQuote.outputAmount, currentQuote.outputDecimals);
    const rate = rateCore.formatNumber(currentQuote.rate, currentQuote.rateDecimals);
    quoteState.textContent = currentQuote.stale ? "Курс устарел" : "Предварительный курс Papakha";
    quoteValue.textContent = `${output} ${currentQuote.receiveCurrency}`;
    quoteRate.textContent = `1 ${currentQuote.giveCurrency} = ${rate} ${currentQuote.receiveCurrency} · обновлено в ${formatTimestamp(currentQuote.updatedAt)}`;
  };

  const createDraftText = (draft) => [
    "Заявка Papakha Exchange",
    `Отдаю: ${draft.amount} ${draft.giveCurrency}`,
    `Получаю: ${draft.receiveAmount ? `${draft.receiveAmount} ` : ""}${draft.receiveCurrency}`,
    `Способ расчёта: ${draft.method}`,
    `Предварительный курс: ${draft.rateLabel || "после подтверждения"}`,
    draft.dealPublicId ? `Номер: ${draft.dealPublicId}` : null,
    draft.rateUpdatedAt ? `Обновлено в ${draft.rateUpdatedAt}${draft.rateStale ? " (курс устарел)" : ""}` : null,
    "Финальный курс подтверждает менеджер",
  ].filter(Boolean).join("\n");

  const openSheet = (draft) => {
    currentDraft = draft;
    document.getElementById("summary-give").textContent = `${draft.amount} ${draft.giveCurrency}`;
    document.getElementById("summary-receive").textContent = `${draft.receiveAmount ? `${draft.receiveAmount} ` : ""}${draft.receiveCurrency}`;
    document.getElementById("summary-method").textContent = draft.method;
    document.getElementById("summary-rate").textContent = draft.rateLabel || "Подтверждается";
    const rateNote = document.getElementById("summary-rate-note");
    rateNote.hidden = !draft.rateStale;
    rateNote.textContent = draft.rateStale
      ? `Использован последний сохранённый курс от ${draft.rateUpdatedAt}. Финальный курс подтверждает менеджер.`
      : "";
    renderDealState(currentDeal);
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

  const statusLabels = Object.freeze({
    new: "Новая", reviewing: "Проверяется", rate_offered: "Курс предложен",
    rate_accepted: "Курс принят", awaiting_payment: "Ожидается оплата",
    payment_review: "Проверяем оплату", exchange_in_progress: "Обмен выполняется",
    completed: "Завершена", cancelled: "Отменена", dispute: "На проверке",
  });

  const authHeaders = () => {
    if (telegram?.initData) return { "X-Telegram-Init-Data": telegram.initData };
    const developmentUserId = window.PAPAKHA_CONFIG?.developmentUserId;
    return developmentUserId ? { "X-Dev-Telegram-User": String(developmentUserId) } : {};
  };

  const apiRequest = async (path, options = {}) => {
    if (!apiBaseUrl) throw new Error("Сервис заявок не настроен");
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...authHeaders(), ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error?.message || "Не удалось выполнить запрос");
    return payload;
  };

  const openAdminPanel = async () => {
    try {
      notify("Открываем админ-панель…");
      const payload = await apiRequest("/api/admin/handoff", { method: "POST", body: "{}" });
      window.location.replace(payload.adminUrl);
    } catch (error) {
      notify(error.message || "Нет доступа к админ-панели");
    }
  };

  function renderDealState(deal) {
    currentDeal = deal || null;
    dealState.hidden = !deal;
    if (!deal) {
      sheetEyebrow.textContent = "ОТПРАВКА ЗАЯВКИ";
      sheetTitle.innerHTML = "Проверьте<br />заявку.";
      clientDealActions.hidden = true;
      return;
    }
    sheetEyebrow.textContent = "ЗАЯВКА ОТПРАВЛЕНА";
    sheetTitle.innerHTML = "Менеджер<br />уже видит её.";
    dealPublicId.textContent = deal.publicId;
    dealStatus.textContent = statusLabels[deal.status] || deal.status;
    sheetNote.textContent = deal.paymentInstructions || "Следите за статусом здесь и в сообщениях Telegram. Финальный курс подтверждает менеджер.";
    clientDealActions.hidden = false;
    clientDealActions.querySelector('[data-deal-action="accept-rate"]').hidden = deal.status !== "rate_offered";
    clientDealActions.querySelector('[data-deal-action="reject-rate"]').hidden = deal.status !== "rate_offered";
    clientDealActions.querySelector('[data-deal-action="payment-sent"]').hidden = !["rate_accepted", "awaiting_payment"].includes(deal.status);
    currentDraft = currentDraft ? { ...currentDraft, dealPublicId: deal.publicId } : currentDraft;
    if (["completed", "cancelled"].includes(deal.status)) window.clearTimeout(dealPollTimer);
  }

  const pollDeal = async () => {
    if (!currentDeal?.id) return;
    try { renderDealState((await apiRequest(`/api/deals/${encodeURIComponent(currentDeal.id)}`)).deal); } catch { /* Telegram notifications remain available. */ }
    window.clearTimeout(dealPollTimer);
    if (currentDeal && !["completed", "cancelled"].includes(currentDeal.status)) dealPollTimer = window.setTimeout(pollDeal, 10000);
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
    button.addEventListener("click", () => {
      const fromHomeCta = button.matches(".home-primary");
      showScreen(button.dataset.screenLink, fromHomeCta);
    });
  });

  amountInput.addEventListener("input", () => {
    amountError.textContent = "";
    amountInput.removeAttribute("aria-invalid");
    updateQuote();
  });

  const validateCurrentStep = () => {
    if (currentSurveyStep === 0 && !selectedValue("giveCurrency")) return "Выберите валюту";
    if (currentSurveyStep === 1 && !parseAmount(amountInput.value)) {
      amountError.textContent = "Введите сумму больше нуля";
      amountInput.setAttribute("aria-invalid", "true");
      amountInput.focus();
      return "";
    }
    if (currentSurveyStep === 2 && !selectedValue("receiveCurrency")) return "Выберите валюту получения";
    if (currentSurveyStep === 3 && !selectedValue("method")) return "Выберите способ расчёта";
    return null;
  };

  const finishSurvey = async () => {
    updateQuote();
    const receiveAmount = currentQuote
      ? rateCore.formatNumber(currentQuote.outputAmount, currentQuote.outputDecimals)
      : null;
    const rateLabel = currentQuote
      ? `1 ${currentQuote.giveCurrency} = ${rateCore.formatNumber(currentQuote.rate, currentQuote.rateDecimals)} ${currentQuote.receiveCurrency}`
      : null;
    const draft = {
      amount: formatTypedAmount(amountInput.value),
      giveCurrency: selectedValue("giveCurrency"),
      receiveCurrency: selectedValue("receiveCurrency"),
      method: selectedValue("method"),
      receiveAmount,
      rateLabel,
      rateUpdatedAt: currentQuote ? formatTimestamp(currentQuote.updatedAt) : null,
      rateStale: Boolean(currentQuote?.stale),
    };

    try {
      window.localStorage.setItem("papakhaExchangeDraft", JSON.stringify(draft));
    } catch {
      // The app remains fully usable when device storage is unavailable.
    }

    surveyNext.disabled = true;
    surveyNext.firstChild.textContent = "Отправляем\n";
    try {
      const requestId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const payload = await apiRequest("/api/deals", {
        method: "POST",
        headers: { "Idempotency-Key": requestId },
        body: JSON.stringify({ amount: amountInput.value.trim().replace(/\s/g, "").replace(",", "."), giveCurrency: draft.giveCurrency, receiveCurrency: draft.receiveCurrency, method: draft.method }),
      });
      currentDeal = payload.deal;
      openSheet({ ...draft, dealPublicId: payload.deal.publicId });
      pollDeal();
    } catch (error) {
      surveyError.textContent = error.message || "Не удалось отправить заявку. Попробуйте ещё раз.";
      telegram?.HapticFeedback?.notificationOccurred("error");
    } finally {
      surveyNext.disabled = false;
      surveyNext.firstChild.textContent = "Создать заявку\n";
    }
  };

  surveyNext.addEventListener("click", () => {
    const validationMessage = validateCurrentStep();
    if (validationMessage !== null) {
      if (validationMessage) surveyError.textContent = validationMessage;
      telegram?.HapticFeedback?.notificationOccurred("error");
      return;
    }
    if (currentSurveyStep === surveySteps.length - 1) finishSurvey();
    else setSurveyStep(currentSurveyStep + 1);
  });

  surveyBack.addEventListener("click", () => setSurveyStep(currentSurveyStep - 1));

  form.querySelectorAll('.choice-list input[type="radio"]').forEach((input) => {
    input.addEventListener("change", () => {
      surveyError.textContent = "";
      if (input.name === "giveCurrency") updateReceiveChoices();
      updateQuote();
      tap("medium");
      window.setTimeout(() => {
        if (currentSurveyStep !== 1 && currentSurveyStep < surveySteps.length - 1) {
          setSurveyStep(currentSurveyStep + 1);
        }
      }, 160);
    });
  });

  form.addEventListener("submit", (event) => event.preventDefault());

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

  clientDealActions.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-deal-action]");
    if (!button || !currentDeal) return;
    button.disabled = true;
    try {
      const payload = await apiRequest(`/api/deals/${encodeURIComponent(currentDeal.id)}/${button.dataset.dealAction}`, { method: "POST", body: "{}" });
      renderDealState(payload.deal);
      notify("Статус обновлён");
    } catch (error) { notify(error.message || "Не удалось обновить статус"); }
    finally { button.disabled = false; }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sheet.classList.contains("is-open")) closeSheet();
  });

  try {
    const savedDraft = JSON.parse(window.localStorage.getItem("papakhaExchangeDraft"));
    if (savedDraft?.amount && savedDraft?.giveCurrency && savedDraft?.receiveCurrency) {
      amountInput.value = savedDraft.amount;
      ["giveCurrency", "receiveCurrency", "method"].forEach((name) => {
        const value = savedDraft[name];
        const input = form.querySelector(`input[name="${name}"][value="${value}"]`);
        if (input) input.checked = true;
      });
    }
  } catch {
    // Ignore invalid or unavailable local storage.
  }

  const previewTheme = new URLSearchParams(window.location.search).get("theme");
  if (["localhost", "127.0.0.1"].includes(window.location.hostname) && previewTheme === "dark") {
    document.body.classList.add("theme-dark");
  }

  setSurveyStep(0);
  initTelegram();
  loadRates();
  const launchParam = telegram?.initDataUnsafe?.start_param
    || new URLSearchParams(window.location.search).get("tgWebAppStartParam")
    || new URLSearchParams(window.location.search).get("startapp");
  if (launchParam === "admin") openAdminPanel();
  const requestedDeal = new URLSearchParams(window.location.search).get("deal");
  if (requestedDeal) {
    apiRequest(`/api/deals/${encodeURIComponent(requestedDeal)}`).then(({ deal }) => {
      currentDeal = deal;
      openSheet({
        amount: deal.giveAmount, giveCurrency: deal.giveCurrency, receiveCurrency: deal.receiveCurrency,
        method: deal.paymentMethod, receiveAmount: deal.receiveAmount, rateLabel: deal.quotedRate,
        rateUpdatedAt: deal.quoteUpdatedAt ? formatTimestamp(deal.quoteUpdatedAt) : null,
        rateStale: deal.quoteStale, dealPublicId: deal.publicId,
      });
      pollDeal();
    }).catch(() => notify("Не удалось открыть заявку"));
  }
  window.setInterval(loadRates, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadRates();
  });
})();
