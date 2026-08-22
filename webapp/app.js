const tg = window.Telegram ? window.Telegram.WebApp : null;

/* ---------- Telegram init: fullscreen + theme ---------- */

function versionAtLeast(target) {
    if (!tg || !tg.version) return false;
    const a = String(tg.version).split('.').map(Number);
    const b = target.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0;
        const y = b[i] || 0;
        if (x !== y) return x > y;
    }
    return true;
}

function applySafeArea() {
    const root = document.documentElement;
    const content = (tg && tg.contentSafeAreaInset) || {};
    const device = (tg && tg.safeAreaInset) || {};
    const top = (device.top || 0) + (content.top || 0);
    const bottom = (device.bottom || 0) + (content.bottom || 0);
    root.style.setProperty('--safe-top', top + 'px');
    root.style.setProperty('--safe-bottom', bottom + 'px');
}

function applyViewport() {
    const root = document.documentElement;
    const height = (tg && tg.viewportHeight) ? tg.viewportHeight : window.innerHeight;
    root.style.setProperty('--app-h', Math.round(height) + 'px');
    applySafeArea();
}

function initTelegram() {
    if (!tg) {
        document.documentElement.style.setProperty('--safe-top', '12px');
        applyViewport();
        window.addEventListener('resize', applyViewport);
        return;
    }

    tg.ready();
    tg.expand();

    const goFullscreen = () => {
        if (typeof tg.requestFullscreen === 'function') {
            try { tg.requestFullscreen(); } catch (e) { /* клиент не поддерживает */ }
        }
    };
    goFullscreen();
    setTimeout(goFullscreen, 250);

    if (versionAtLeast('8.0') || typeof tg.disableVerticalSwipes === 'function') {
        try { tg.disableVerticalSwipes(); } catch (e) { /* клиент не поддерживает */ }
        tg.onEvent('safeAreaChanged', applyViewport);
        tg.onEvent('contentSafeAreaChanged', applyViewport);
        tg.onEvent('fullscreenChanged', applyViewport);
    }

    tg.onEvent('viewportChanged', applyViewport);
    window.addEventListener('resize', applyViewport);

    if (versionAtLeast('6.1')) {
        tg.setHeaderColor('#08050f');
        tg.setBackgroundColor('#08050f');
    }
    if (versionAtLeast('7.10')) {
        tg.disableClosingConfirmation();
    }

    applyViewport();
}

/* ---------- Haptics ---------- */

const haptic = {
    impact(style = 'light') {
        if (tg && tg.HapticFeedback && versionAtLeast('6.1')) {
            tg.HapticFeedback.impactOccurred(style);
        } else if (navigator.vibrate) {
            navigator.vibrate(style === 'heavy' ? 24 : style === 'medium' ? 14 : 8);
        }
    },
    notify(type = 'success') {
        if (tg && tg.HapticFeedback && versionAtLeast('6.1')) {
            tg.HapticFeedback.notificationOccurred(type);
        } else if (navigator.vibrate) {
            navigator.vibrate([12, 40, 12]);
        }
    },
    select() {
        if (tg && tg.HapticFeedback && versionAtLeast('6.1')) {
            tg.HapticFeedback.selectionChanged();
        } else if (navigator.vibrate) {
            navigator.vibrate(6);
        }
    },
};

const HAPTIC_SELECTOR = 'button, .device, .chip, .slot-add, .card-row, .copy-btn, [data-haptic]';

document.addEventListener('pointerdown', (event) => {
    const target = event.target.closest(HAPTIC_SELECTOR);
    if (!target) return;
    const style = target.dataset.haptic || 'light';
    if (style === 'select') haptic.select();
    else haptic.impact(style);
}, { passive: true });

/* ---------- Данные ---------- */

const STATUS_LABEL = {
    online: 'Доступен',
    busy: 'В работе',
    offline: 'Офлайн',
    new: 'Не подключён',
    blocked: 'Ozon блок',
};

const API = 'https://api.ozpay.ru:5001/api';
const devices = [];
const localChecks = new Map();
const serverBusy = new Set();

let activeFilter = 'all';
let pollTimer = null;

async function api(path, options = {}) {
    const response = await fetch(API + path, {
        ...options,
        mode: 'cors',
        credentials: 'omit',
        headers: { Accept: 'application/json', ...(options.headers || {}) },
    });
    const text = await response.text();
    let payload = {};
    try {
        payload = text ? JSON.parse(text) : {};
    } catch (error) {
        throw new Error('Сервер вернул не JSON');
    }
    if (!response.ok) {
        const detail = payload.detail;
        const message = Array.isArray(detail)
            ? detail.map((item) => item.msg || item).join(', ')
            : (detail || `${response.status} ${response.statusText}`);
        throw new Error(message);
    }
    return payload;
}

function checkingField(deviceId) {
    if (localChecks.has(deviceId)) return localChecks.get(deviceId);
    if (serverBusy.has(deviceId)) return 'all';
    return null;
}

function isChecking(deviceId, field) {
    const current = checkingField(deviceId);
    if (!current) return false;
    return field ? current === field || current === 'all' : true;
}

function checkingClass(deviceId) {
    return isChecking(deviceId) ? ' is-checking' : '';
}

function loadingClass(deviceId, field) {
    const current = checkingField(deviceId);
    if (!current) return '';
    if (current === 'all' || current === field) return ' is-loading';
    return '';
}

function busyClass(deviceId, field) {
    const current = checkingField(deviceId);
    if (current === field || current === 'all') return ' is-busy';
    return '';
}

function deviceIsBusy(item) {
    return Boolean(item && (item.checking || item.status === 'busy'));
}

function normalizeDevice(item) {
    return {
        ...item,
        cards: Array.isArray(item.cards) ? item.cards : [],
    };
}

function syncServerBusy(list) {
    serverBusy.clear();
    list.forEach((item) => {
        if (deviceIsBusy(item)) serverBusy.add(item.id);
    });
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

function startPollingIfNeeded() {
    if (serverBusy.size === 0) {
        stopPolling();
        return;
    }
    if (pollTimer) return;
    pollTimer = setInterval(pollBusyDevices, 2000);
}

function refreshAll() {
    if (deviceScreen.classList.contains('screen--active')) {
        const detail = deviceScreen.querySelector('.detail');
        const id = detail && detail.dataset.id;
        const device = id && devices.find((item) => item.id === id);
        if (device) deviceScreen.innerHTML = renderDeviceScreen(device);
    }
    if (listScreen.classList.contains('screen--active')) {
        renderDevices();
    }
}

async function pollBusyDevices() {
    if (serverBusy.size === 0) {
        stopPolling();
        return;
    }
    try {
        const data = await api('/devices');
        if (!Array.isArray(data.devices)) return;
        const wasBusy = new Set(serverBusy);
        data.devices.forEach((item) => upsertDevice(normalizeDevice(item)));
        syncServerBusy(data.devices);
        const finished = [...wasBusy].filter((id) => !serverBusy.has(id) && !localChecks.has(id));
        refreshAll();
        if (finished.length) haptic.notify('success');
    } catch (error) {
        /* оставляем блокировку, пока сервер занят */
    }
    if (serverBusy.size === 0) stopPolling();
}

function upsertDevice(updated) {
    const index = devices.findIndex((item) => item.id === updated.id);
    if (index >= 0) devices[index] = updated;
    else devices.push(updated);
}

async function loadDevices() {
    const data = await api('/devices');
    if (!Array.isArray(data.devices)) {
        throw new Error('API не вернул список девайсов');
    }
    devices.splice(0, devices.length, ...data.devices.map(normalizeDevice));
    syncServerBusy(data.devices);
    renderDevices();
    startPollingIfNeeded();
}

const moneyFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

function money(value) {
    return moneyFormat.format(value || 0) + ' ₽';
}

function turnover(device) {
    return device.outcome || 0;
}

function last4(card) {
    return (card.number || '').replace(/\s/g, '').slice(-4);
}

function renderCards(cards) {
    const list = Array.isArray(cards) ? cards : [];
    if (!list.length) {
        return '<span class="card-stack__empty">Карт нет</span>';
    }
    const shown = list.slice(0, 4).map((card) => `
        <span class="mini-card">${last4(card)}</span>
    `).join('');
    const rest = list.length - 4;
    return shown + (rest > 0 ? `<span class="card-stack__more">+${rest}</span>` : '');
}

const LOAD_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
        <path d="M21 3v6h-6"></path>
    </svg>
`;

/* ---------- Рендер ---------- */

const deviceList = document.getElementById('deviceList');

function renderDevices() {
    const visible = devices.filter((d) => {
        if (activeFilter === 'all') return true;
        if (activeFilter === 'online') return d.status === 'online' || isChecking(d.id);
        return d.status === activeFilter;
    });
    document.getElementById('deviceCount').textContent = visible.length;

    if (!devices.length) {
        deviceList.innerHTML = '<div class="empty">В базе пока нет девайсов.</div>';
        return;
    }

    if (!visible.length) {
        deviceList.innerHTML = '<div class="empty">Нет девайсов в этой категории.</div>';
        return;
    }

    deviceList.innerHTML = visible.map((device, index) => renderDevice(device, index)).join('');
}

function renderDevice(device, index = 0) {
    const id = device.id;
    return `
        <div class="device device--${device.status}${checkingClass(id)}" data-id="${id}" style="animation-delay:${index * 45}ms">
            <div class="device__head">
                <div class="device__title">
                    <span class="device__name">${listName(device)}</span>
                    <span class="device__meta">
                        ${device.number}
                        <button class="copy-btn" data-copy="${phoneDigits(device.number)}" aria-label="Скопировать номер">${COPY_ICON}</button>
                    </span>
                    ${device.blocked ? '<span class="device__block">Ozon: операции приостановлены</span>' : ''}
                </div>
                <button class="load-btn${busyClass(id, 'all')}" data-check="all" aria-label="Полная проверка">${LOAD_ICON}</button>
            </div>
            <div class="device__stats">
                <div class="tile${loadingClass(id, 'balance')}" data-field="balance">
                    <button class="load-btn load-btn--sm${busyClass(id, 'balance')}" data-check="balance" aria-label="Обновить баланс">${LOAD_ICON}</button>
                    <b class="tile__value">${money(device.balance)}</b>
                    <span class="tile__label">баланс</span>
                </div>
                <div class="tile${loadingClass(id, 'turnover')}" data-field="turnover">
                    <button class="load-btn load-btn--sm${busyClass(id, 'turnover')}" data-check="turnover" aria-label="Обновить оборот">${LOAD_ICON}</button>
                    <b class="tile__value">${money(turnover(device))}</b>
                    <span class="tile__label">оборот</span>
                </div>
            </div>
            <div class="tile tile--cards${loadingClass(id, 'cards')}" data-field="cards">
                <button class="load-btn load-btn--sm${busyClass(id, 'cards')}" data-check="cards" aria-label="Обновить карты">${LOAD_ICON}</button>
                <span class="tile__label">карты</span>
                <div class="card-stack">${renderCards(device.cards)}</div>
            </div>
        </div>
    `;
}

/* ---------- Экран управления девайсом ---------- */

const listScreen = document.getElementById('listScreen');
const deviceScreen = document.getElementById('deviceScreen');
const screensEl = document.querySelector('.screens');

const BACK_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 5l-7 7 7 7"></path>
    </svg>
`;

const COPY_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="11" height="13" rx="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
`;

function renderCardSwitch(flag, label, on) {
    return `
        <button type="button" class="card-switch${on ? ' is-on' : ''}" data-flag="${flag}" aria-pressed="${on ? 'true' : 'false'}">
            <span>${label}</span>
            <i class="card-switch__track" aria-hidden="true"></i>
        </button>
    `;
}

function renderCardFull(card, deviceId) {
    const number = card.number || '—';
    const expiry = card.expiry || '—';
    const cvv = card.cvv || '—';
    const numberRaw = (card.number || '').replace(/\s/g, '');
    const beeline = Boolean(card.beeline);
    const yapay = Boolean(card.yapay);
    return `
        <div class="card-row" data-device="${deviceId}" data-number="${numberRaw}" data-expiry="${expiry}" data-cvv="${cvv}">
            <div class="card-row__preview">
                <div class="card-row__meta">
                    <span class="card-row__num">${number}</span>
                    <span class="card-row__date">${expiry}</span>
                    <span class="card-row__cvv">${cvv}</span>
                </div>
                <div class="card-row__dots" aria-hidden="true">
                    <span class="card-dot card-dot--beeline"${beeline ? '' : ' hidden'}></span>
                    <span class="card-dot card-dot--yapay"${yapay ? '' : ' hidden'}></span>
                </div>
            </div>
            <div class="card-row__expand">
                <button type="button" class="card-copy" data-copy="${numberRaw}" data-copy-msg="Номер скопирован">
                    <span>номер</span>
                    <b>${number}</b>
                    ${COPY_ICON}
                </button>
                <div class="card-copy-row">
                    <button type="button" class="card-copy" data-copy="${expiry}" data-copy-msg="Дата скопирована">
                        <span>дата</span>
                        <b>${expiry}</b>
                        ${COPY_ICON}
                    </button>
                    <button type="button" class="card-copy" data-copy="${cvv}" data-copy-msg="CVV скопирован">
                        <span>cvv</span>
                        <b>${cvv}</b>
                        ${COPY_ICON}
                    </button>
                </div>
                <div class="card-flags">
                    ${renderCardSwitch('beeline', 'Билайн', beeline)}
                    ${renderCardSwitch('yapay', 'Япей', yapay)}
                </div>
            </div>
        </div>
    `;
}

const LOGIN_OFF_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a5 5 0 0 1 5 5v3"></path>
        <path d="M7 10V7a5 5 0 0 1 .5-2.2"></path>
        <rect x="4" y="10" width="16" height="11" rx="2.5"></rect>
        <path d="M3 3l18 18"></path>
    </svg>
`;

const CHECK_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 6L9 17l-5-5"></path>
    </svg>
`;

function deviceLabel(device) {
    return device.id || '—';
}

function lkName(device) {
    const name = (device.name || '').trim();
    return name || '—';
}

function listName(device) {
    const name = (device.name || '').trim();
    return name || device.id || '—';
}

function renderDeviceSpecs(device) {
    return `
        <div class="spec-grid">
            <div class="spec-cell">
                <span>имя</span>
                <b>${lkName(device)}</b>
            </div>
            <div class="spec-cell">
                <span>ip</span>
                <b>${device.ip || '—'}</b>
            </div>
            <div class="spec-cell">
                <span>порт</span>
                <b>${device.port || '—'}</b>
            </div>
        </div>
    `;
}

const LK_COPY_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="8" y="8" width="12" height="13" rx="2"></rect>
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2"></path>
        <path d="M11 13h6M11 16h4"></path>
    </svg>
`;

const KEY_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="8" cy="15" r="4"></circle>
        <path d="M10.8 12.2L21 2"></path>
        <path d="M16 3l3 3"></path>
        <path d="M19 6l2 2"></path>
    </svg>
`;

const LOGOUT_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
        <path d="M16 17l5-5-5-5"></path>
        <path d="M21 12H9"></path>
    </svg>
`;

const TRASH_ICON = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 7h16"></path>
        <path d="M9 7V5h6v2"></path>
        <path d="M9 11v7M12 11v7M15 11v7"></path>
        <path d="M6 7l1 13h10l1-13"></path>
    </svg>
`;

function renderNewDeviceScreen(device) {
    return `
        <div class="detail device--${device.status}" data-id="${device.id}">
            <div class="detail__top">
                <button class="icon-btn" data-action="back" aria-label="Назад">${BACK_ICON}</button>
                <div class="detail__title-wrap">
                    <span class="detail__name">${deviceLabel(device)}</span>
                    <span class="detail__meta">
                        <i class="detail__dot"></i>${STATUS_LABEL[device.status] || device.status}
                    </span>
                </div>
                <button class="icon-btn" data-action="check-login" aria-label="Проверить вход">${LOAD_ICON}</button>
                <button class="icon-btn icon-btn--danger" data-action="delete" aria-label="Удалить">${TRASH_ICON}</button>
            </div>
            ${renderDeviceSpecs(device)}
            <div class="login-state" id="loginState">
                <div class="login-state__icon">${LOGIN_OFF_ICON}</div>
                <p class="login-state__title">Вход в личный кабинет не выполнен</p>
                <button class="btn btn--primary login-state__btn" data-action="login">Добавить</button>
            </div>
        </div>
    `;
}

function renderDeviceScreen(device) {
    if (device.status === 'new' || device.linked === false) {
        return renderNewDeviceScreen(device);
    }
    const flowTotal = (device.income || 0) + (device.outcome || 0) || 1;
    const inShare = Math.round((device.income / flowTotal) * 100);

    return `
        <div class="detail device--${device.status}${checkingClass(device.id)}" data-id="${device.id}">
            <div class="detail__top">
                <button class="icon-btn" data-action="back" aria-label="Назад">${BACK_ICON}</button>
                <div class="detail__title-wrap">
                    <span class="detail__name">${lkName(device)}</span>
                    <span class="detail__meta">
                        <i class="detail__dot"></i>${STATUS_LABEL[device.status] || device.status} · ${device.number}
                        <button class="copy-btn" data-copy="${phoneDigits(device.number)}" aria-label="Скопировать номер">${COPY_ICON}</button>
                    </span>
                </div>
                <div class="detail__actions">
                    <button class="icon-btn icon-btn--block" data-action="copy-lk" aria-label="Скопировать данные ЛК">${LK_COPY_ICON}</button>
                    <button class="icon-btn" data-action="password" aria-label="Сменить код-пароль">${KEY_ICON}</button>
                    <button class="icon-btn icon-btn--warn" data-action="logout" aria-label="Выйти из ЛК">${LOGOUT_ICON}</button>
                    <button class="icon-btn icon-btn--danger" data-action="delete" aria-label="Удалить">${TRASH_ICON}</button>
                    <button class="load-btn${busyClass(device.id, 'all')}" data-check="all" aria-label="Полная проверка">${LOAD_ICON}</button>
                </div>
            </div>

            ${renderDeviceSpecs(device)}
            ${device.blocked ? '<div class="block-banner">Ozon заблокирован: операции приостановлены</div>' : ''}

            <div class="tile detail__balance${loadingClass(device.id, 'balance')}" data-field="balance">
                <button class="load-btn load-btn--sm${busyClass(device.id, 'balance')}" data-check="balance" aria-label="Обновить баланс">${LOAD_ICON}</button>
                <span class="tile__label">баланс</span>
                <span class="detail__balance-value">${money(device.balance)}</span>
            </div>

            <div class="detail__flow${loadingClass(device.id, 'turnover')}" data-field="turnover">
                <div class="tile flow flow--in">
                    <b class="flow__value">+${money(device.income)}</b>
                    <span class="tile__label">приход</span>
                </div>
                <div class="tile flow flow--out">
                    <button class="load-btn load-btn--sm${busyClass(device.id, 'turnover')}" data-check="turnover" aria-label="Обновить оборот">${LOAD_ICON}</button>
                    <b class="flow__value">−${money(device.outcome)}</b>
                    <span class="tile__label">расход</span>
                </div>
            </div>

            <div class="flow-bar">
                <i style="width:${inShare}%"></i>
            </div>
            <div class="flow-legend">
                <span>оборот ${money(turnover(device))}</span>
                <span>приход ${inShare}%</span>
            </div>

            <div class="section-head">
                <h2 class="section-title">Карты</h2>
                <span class="section-count">${device.cards.length}</span>
                <button class="load-btn load-btn--sm load-btn--inline${busyClass(device.id, 'cards')}" data-check="cards" aria-label="Обновить карты">${LOAD_ICON}</button>
            </div>
            <div class="cards-full${loadingClass(device.id, 'cards')}" data-field="cards">
                ${(device.cards && device.cards.length) ? device.cards.map((card) => renderCardFull(card, device.id)).join('') : '<div class="empty">Карты не привязаны.</div>'}
            </div>
        </div>
    `;
}

function openDevice(id) {
    const device = devices.find((d) => d.id === id);
    if (!device) return;

    deviceScreen.innerHTML = renderDeviceScreen(device);
    listScreen.classList.remove('screen--active');
    deviceScreen.classList.add('screen--active');
    screensEl.scrollTop = 0;
    haptic.impact('medium');

    if (tg && tg.BackButton) {
        tg.BackButton.show();
        tg.BackButton.onClick(closeDevice);
    }
}

function closeDevice() {
    deviceScreen.classList.remove('screen--active');
    listScreen.classList.add('screen--active');
    deviceScreen.innerHTML = '';
    screensEl.scrollTop = 0;

    if (tg && tg.BackButton) {
        tg.BackButton.hide();
        tg.BackButton.offClick(closeDevice);
    }
}

function askChangePassword(deviceId) {
    haptic.impact('medium');
    openSheet(`
        <h3 class="sheet__title">Сменить код-пароль</h3>
        <p class="sheet__sub">Пароль в Ozon вы меняете сами. Здесь только запись в базу для этого ЛК.</p>
        <form class="form" id="passwordForm" autocomplete="off">
            <label class="field">
                <span class="field__label">Новый код-пароль *</span>
                <input class="field__input" name="password" placeholder="4 цифры" inputmode="numeric" autocomplete="off" maxlength="8" required>
            </label>
            <div class="sheet__actions">
                <button type="submit" class="btn btn--primary">Сохранить</button>
                <button type="button" class="btn" data-action="cancel">Отмена</button>
            </div>
        </form>
    `);
    const form = document.getElementById('passwordForm');
    form.addEventListener('submit', (event) => onPasswordSubmit(event, deviceId));
    form.elements.password.addEventListener('input', () => {
        form.elements.password.value = form.elements.password.value.replace(/\D/g, '');
    });
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        haptic.impact('light');
        closeSheet();
    });
    setTimeout(() => form.elements.password.focus(), 80);
}

async function onPasswordSubmit(event, deviceId) {
    event.preventDefault();
    const form = event.currentTarget;
    const submitBtn = form.querySelector('button[type="submit"]');
    const password = form.elements.password.value.replace(/\D/g, '');
    if (password.length < 4) {
        showToast('Код-пароль: минимум 4 цифры');
        return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохраняю…';
    try {
        await api(`/devices/${encodeURIComponent(deviceId)}/password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });
        haptic.notify('success');
        closeSheet();
        showToast('Пароль обновлён в базе');
    } catch (error) {
        haptic.notify('error');
        showToast(error.message || 'Не удалось сохранить пароль');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Сохранить';
    }
}

function askLogoutDevice(deviceId) {
    const device = devices.find((item) => item.id === deviceId);
    const label = device ? (lkName(device) || deviceLabel(device)) : deviceId;
    haptic.impact('medium');
    openSheet(`
        <h3 class="sheet__title">Выйти из ЛК</h3>
        <p class="sheet__sub">На устройстве выйдем из аккаунта ${label}. В панели откроется экран добавления ЛК.</p>
        <div class="sheet__actions">
            <button type="button" class="btn btn--danger" data-action="confirm-logout">Выйти</button>
            <button type="button" class="btn" data-action="cancel">Отмена</button>
        </div>
    `);
    sheetContent.querySelector('[data-action="confirm-logout"]').addEventListener('click', () => {
        closeSheet();
        logoutDevice(deviceId);
    });
    sheetContent.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        haptic.impact('light');
        closeSheet();
    });
}

async function logoutDevice(deviceId) {
    if (isChecking(deviceId)) {
        showToast('Дождитесь окончания проверки');
        return;
    }
    localChecks.set(deviceId, 'all');
    refreshView(deviceId);
    haptic.impact('medium');
    try {
        const data = await api(`/devices/${encodeURIComponent(deviceId)}/logout`, { method: 'POST' });
        if (!data.device) throw new Error('API не вернул девайс');
        upsertDevice(normalizeDevice(data.device));
        haptic.notify('success');
        showToast('Вышли из ЛК');
    } catch (error) {
        haptic.notify('error');
        showToast(error.message || 'Не удалось выйти из ЛК');
    } finally {
        localChecks.delete(deviceId);
        refreshView(deviceId);
    }
}

function askDeleteDevice(deviceId) {
    const device = devices.find((item) => item.id === deviceId);
    const label = device ? deviceLabel(device) : deviceId;
    haptic.impact('medium');
    openSheet(`
        <h3 class="sheet__title">Удалить девайс</h3>
        <p class="sheet__sub">${label} будет удалён из базы. Это нельзя отменить.</p>
        <div class="sheet__actions">
            <button type="button" class="btn btn--danger" data-action="confirm-delete">Удалить</button>
            <button type="button" class="btn" data-action="cancel">Отмена</button>
        </div>
    `);
    sheetContent.querySelector('[data-action="confirm-delete"]').addEventListener('click', () => {
        closeSheet();
        removeDevice(deviceId);
    });
    sheetContent.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        haptic.impact('light');
        closeSheet();
    });
}

async function removeDevice(deviceId) {
    try {
        await api(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
        const index = devices.findIndex((item) => item.id === deviceId);
        if (index >= 0) devices.splice(index, 1);
        localChecks.delete(deviceId);
        serverBusy.delete(deviceId);
        haptic.notify('success');
        closeDevice();
        renderDevices();
        showToast('Девайс удалён');
    } catch (error) {
        haptic.notify('error');
        showToast(error.message || 'Не удалось удалить');
    }
}

/* ---------- Проверка девайса ---------- */

function refreshView(deviceId) {
    const device = devices.find((item) => item.id === deviceId);
    const detail = deviceScreen.querySelector('.detail');
    if (detail && deviceScreen.classList.contains('screen--active') && device) {
        deviceScreen.innerHTML = renderDeviceScreen(device);
    }
    if (listScreen.classList.contains('screen--active')) {
        renderDevices();
    }
}

async function checkDevice(rootEl, field) {
    const deviceId = rootEl.dataset.id;
    const device = devices.find((d) => d.id === deviceId);
    if (!device) return;
    if (isChecking(deviceId)) return;

    localChecks.set(deviceId, field);
    refreshView(deviceId);
    haptic.impact('medium');

    try {
        const data = await api(`/devices/${encodeURIComponent(deviceId)}/check/${field}`, { method: 'POST' });
        if (!data.device) throw new Error('API не вернул девайс');
        upsertDevice(normalizeDevice(data.device));
        if (!deviceIsBusy(data.device)) serverBusy.delete(deviceId);
        haptic.notify('success');
    } catch (error) {
        if (String(error.message || '').includes('уже проверяется')) {
            serverBusy.add(deviceId);
            startPollingIfNeeded();
        } else {
            haptic.notify('error');
            showToast(error.message || 'Не удалось обновить');
        }
    } finally {
        localChecks.delete(deviceId);
        if (deviceIsBusy(devices.find((item) => item.id === deviceId))) {
            serverBusy.add(deviceId);
            startPollingIfNeeded();
        }
        refreshView(deviceId);
    }
}

/* ---------- Toast ---------- */

const toastEl = document.getElementById('toast');
let toastTimer = null;

function copyText(text, toast) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    haptic.notify('success');
    showToast(toast);
}

function phoneDigits(number) {
    let digits = String(number || '').replace(/\D/g, '');
    if (digits.length >= 11 && (digits[0] === '7' || digits[0] === '8')) {
        digits = digits.slice(1);
    }
    if (digits.length > 10) digits = digits.slice(-10);
    return digits;
}

function lkCopyText(device) {
    const number = phoneDigits(device.number);
    const name = (device.name || '').trim() || deviceLabel(device);
    return [number, name, 'Ozon Bank'].join('\n');
}

function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-open'), 1900);
}

/* ---------- Bottom sheet ---------- */

const sheet = document.getElementById('sheet');
const sheetBackdrop = document.getElementById('sheetBackdrop');
const sheetContent = document.getElementById('sheetContent');

// Перехватчик закрытия шторки (для входа в ЛК: спросить подтверждение отмены).
let sheetCloseHandler = null;

function requestSheetClose() {
    if (sheetCloseHandler) {
        sheetCloseHandler();
        return;
    }
    closeSheet();
}

function openSheet(html, options = {}) {
    sheetContent.innerHTML = html;
    sheet.classList.toggle('sheet--full', Boolean(options.full));
    sheetCloseHandler = typeof options.onClose === 'function' ? options.onClose : null;
    sheet.classList.add('is-open');
    sheetBackdrop.classList.add('is-open');
    if (tg && tg.BackButton) {
        tg.BackButton.show();
        tg.BackButton.onClick(requestSheetClose);
    }
}

function closeSheet() {
    stopLoginPoll();
    sheetCloseHandler = null;
    sheet.classList.remove('is-open');
    sheet.classList.remove('sheet--full');
    sheetBackdrop.classList.remove('is-open');
    if (tg && tg.BackButton) {
        tg.BackButton.hide();
        tg.BackButton.offClick(requestSheetClose);
    }
}

sheetBackdrop.addEventListener('click', () => {
    haptic.impact('light');
    requestSheetClose();
});

/* ---------- Клики ---------- */

document.getElementById('filterChips').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('chip--active', c === chip));
    activeFilter = chip.dataset.filter;
    renderDevices();
});

deviceList.addEventListener('click', (event) => {
    const card = event.target.closest('.device');
    if (!card) return;

    const loadBtn = event.target.closest('.load-btn');
    if (loadBtn) {
        checkDevice(card, loadBtn.dataset.check);
        return;
    }

    const copyBtn = event.target.closest('.copy-btn');
    if (copyBtn) {
        copyText(copyBtn.dataset.copy, 'Номер скопирован');
        return;
    }

    openDevice(card.dataset.id);
});

deviceScreen.addEventListener('click', (event) => {
    const detail = event.target.closest('.detail');
    if (!detail) return;

    if (event.target.closest('[data-action="back"]')) {
        closeDevice();
        return;
    }

    if (event.target.closest('[data-action="copy-lk"]')) {
        const device = devices.find((item) => item.id === detail.dataset.id);
        if (device) copyText(lkCopyText(device), 'Данные ЛК скопированы');
        return;
    }

    if (event.target.closest('[data-action="password"]')) {
        askChangePassword(detail.dataset.id);
        return;
    }

    if (event.target.closest('[data-action="logout"]')) {
        askLogoutDevice(detail.dataset.id);
        return;
    }

    if (event.target.closest('[data-action="delete"]')) {
        askDeleteDevice(detail.dataset.id);
        return;
    }

    if (event.target.closest('[data-action="login"]')) {
        startLoginFlow(detail.dataset.id);
        return;
    }

    if (event.target.closest('[data-action="check-login"]')) {
        checkLoginState(detail.dataset.id);
        return;
    }

    const loadBtn = event.target.closest('.load-btn');
    if (loadBtn) {
        checkDevice(detail, loadBtn.dataset.check);
        return;
    }

    const copyBtn = event.target.closest('.copy-btn');
    if (copyBtn) {
        copyText(copyBtn.dataset.copy, 'Номер скопирован');
        return;
    }

    const flagSwitch = event.target.closest('.card-switch');
    if (flagSwitch) {
        toggleCardFlag(flagSwitch);
        return;
    }

    const fieldCopy = event.target.closest('.card-copy');
    if (fieldCopy) {
        copyText(fieldCopy.dataset.copy, fieldCopy.dataset.copyMsg || 'Скопировано');
        return;
    }

    const cardEl = event.target.closest('.card-row');
    if (cardEl) {
        if (cardEl.dataset.hold === '1') {
            delete cardEl.dataset.hold;
            return;
        }
        if (cardEl.classList.contains('is-open')) return;
        collapseOpenCards();
        const text = [cardEl.dataset.number, cardEl.dataset.expiry, cardEl.dataset.cvv].join('\n');
        if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
        haptic.notify('success');
        showToast('Данные карты скопированы');
        return;
    }

    collapseOpenCards();
});

function applyCardFlagDom(cardEl, flag, on) {
    const sw = cardEl.querySelector(`.card-switch[data-flag="${flag}"]`);
    if (sw) {
        sw.classList.toggle('is-on', on);
        sw.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const dot = cardEl.querySelector(`.card-dot--${flag}`);
    if (dot) dot.hidden = !on;
}

async function toggleCardFlag(button) {
    const cardEl = button.closest('.card-row');
    if (!cardEl) return;
    const deviceId = cardEl.dataset.device;
    const number = cardEl.dataset.number;
    const flag = button.dataset.flag;
    if (!deviceId || !number || (flag !== 'beeline' && flag !== 'yapay')) return;

    const next = button.getAttribute('aria-pressed') !== 'true';
    applyCardFlagDom(cardEl, flag, next);

    const device = devices.find((item) => item.id === deviceId);
    const card = device && device.cards.find((item) => (item.number || '').replace(/\s/g, '') === number);
    if (card) card[flag] = next;

    try {
        const data = await api(`/devices/${encodeURIComponent(deviceId)}/cards/flags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ number, [flag]: next }),
        });
        if (data.device) upsertDevice(normalizeDevice(data.device));
    } catch (error) {
        applyCardFlagDom(cardEl, flag, !next);
        if (card) card[flag] = !next;
        showToast(error.message || 'Не удалось сохранить');
    }
}

function collapseOpenCards(except) {
    deviceScreen.querySelectorAll('.card-row.is-open').forEach((el) => {
        if (el !== except) el.classList.remove('is-open');
    });
}

let cardHoldTimer = null;
let cardHoldTarget = null;
const CARD_HOLD_MS = 450;

function clearCardHold(moved) {
    if (cardHoldTimer) {
        clearTimeout(cardHoldTimer);
        cardHoldTimer = null;
    }
    if (moved) cardHoldTarget = null;
}

deviceScreen.addEventListener('pointerdown', (event) => {
    const card = event.target.closest('.card-row');
    if (!card || event.target.closest('.card-copy, .card-switch')) return;
    clearCardHold();
    cardHoldTarget = card;
    cardHoldTimer = setTimeout(() => {
        collapseOpenCards(card);
        card.classList.add('is-open');
        card.dataset.hold = '1';
        haptic.impact('medium');
        cardHoldTimer = null;
    }, CARD_HOLD_MS);
});

deviceScreen.addEventListener('pointerup', () => clearCardHold());
deviceScreen.addEventListener('pointercancel', () => clearCardHold(true));
deviceScreen.addEventListener('pointermove', (event) => {
    if (!cardHoldTarget || !cardHoldTimer) return;
    const card = event.target.closest('.card-row');
    if (card !== cardHoldTarget) clearCardHold(true);
});
deviceScreen.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.card-row')) event.preventDefault();
});
deviceScreen.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.card-row')) event.preventDefault();
});

document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-toast]');
    if (!el) return;
    haptic.notify('success');
    showToast(el.dataset.toast);
});

function normalizeIpInput(input) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const next = input.value.replace(/,/g, '.');
    if (next === input.value) return;
    input.value = next;
    if (start != null) input.setSelectionRange(start, end);
}

function groupPhoneDigits(digits) {
    const d = digits.slice(0, 10);
    const parts = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)];
    return parts.filter(Boolean).join(' ');
}

function formatPhoneInput(input) {
    const prevValue = input.value;
    const prevCaret = input.selectionStart != null ? input.selectionStart : prevValue.length;
    const digitsBeforeCaret = prevValue.slice(0, prevCaret).replace(/\D/g, '').length;

    let digits = prevValue.replace(/\D/g, '');
    if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
        digits = digits.slice(1);
    }
    digits = digits.slice(0, 10);

    const formatted = groupPhoneDigits(digits);
    input.value = formatted;

    let caret = 0;
    let seen = 0;
    while (caret < formatted.length && seen < digitsBeforeCaret) {
        if (/\d/.test(formatted[caret])) seen += 1;
        caret += 1;
    }
    if (input.setSelectionRange) input.setSelectionRange(caret, caret);
}

function openAddSheet() {
    haptic.impact('medium');
    openSheet(`
        <h3 class="sheet__title">Новый девайс</h3>
        <form class="form" id="addForm" autocomplete="off">
            <label class="field">
                <span class="field__label">Имя девайса *</span>
                <input class="field__input" name="device" placeholder="device1 или redroid00" required>
            </label>
            <label class="field">
                <span class="field__label">IP *</span>
                <input class="field__input" name="ip" placeholder="192.168.0.10" inputmode="decimal" required>
            </label>
            <label class="field">
                <span class="field__label">Порт *</span>
                <input class="field__input" name="port" placeholder="5555" inputmode="numeric" required>
            </label>
            <div class="sheet__actions">
                <button type="submit" class="btn btn--primary">Сохранить</button>
                <button type="button" class="btn" data-action="cancel">Отмена</button>
            </div>
        </form>
    `);

    const form = document.getElementById('addForm');
    form.addEventListener('submit', onAddSubmit);
    form.elements.ip.addEventListener('input', () => normalizeIpInput(form.elements.ip));
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        haptic.impact('light');
        closeSheet();
    });
    setTimeout(() => form.elements.device.focus(), 80);
}

async function onAddSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submitBtn = form.querySelector('button[type="submit"]');
    const device = form.elements.device.value.trim();
    if (!device) {
        showToast('Укажите имя девайса');
        return;
    }

    const payload = {
        id: device,
        ip: form.elements.ip.value.replace(/,/g, '.').trim(),
        port: form.elements.port.value.trim(),
    };
    if (!payload.ip || !payload.port) {
        showToast('Укажите IP и порт');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Проверяю ADB…';
    try {
        const data = await api('/devices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!data.device) throw new Error('API не вернул девайс');
        upsertDevice(normalizeDevice(data.device));
        renderDevices();
        haptic.notify('success');
        closeSheet();
        showToast('Девайс добавлен');
    } catch (error) {
        haptic.notify('error');
        showToast(error.message || 'Не удалось добавить');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Сохранить';
    }
}

/* ---------- Вход в личный кабинет (add_device) ---------- */

const LOGIN_STORAGE_KEY = 'ozpay:activeLogin';
const RESUMABLE_LOGIN_STATUSES = ['running', 'awaiting_code', 'verifying'];

let loginPollTimer = null;
let loginShownStatus = null;
let loginCancelling = false;

function setActiveLogin(deviceId) {
    try { localStorage.setItem(LOGIN_STORAGE_KEY, deviceId); } catch (e) { /* приватный режим */ }
}

function clearActiveLogin() {
    try { localStorage.removeItem(LOGIN_STORAGE_KEY); } catch (e) { /* приватный режим */ }
}

function stopLoginPoll() {
    if (loginPollTimer) {
        clearTimeout(loginPollTimer);
        loginPollTimer = null;
    }
}

function scheduleLoginPoll(deviceId, delay = 2000) {
    stopLoginPoll();
    loginPollTimer = setTimeout(() => tickLogin(deviceId), delay);
}

function renderLoginProgress(title, sub, options = {}) {
    const { deviceId = null, cancel = true } = options;
    const cancelBtn = (cancel && deviceId)
        ? `<div class="sheet__actions"><button type="button" class="btn" data-action="cancel-login">Отменить вход</button></div>`
        : '';
    openSheet(`
        <h3 class="sheet__title">${title}</h3>
        <p class="sheet__sub">${sub}</p>
        <div class="login-progress"><span class="login-progress__spinner">${LOAD_ICON}</span></div>
        ${cancelBtn}
    `, {
        full: true,
        onClose: deviceId ? () => confirmCancelLogin(deviceId) : undefined,
    });
    if (cancel && deviceId) {
        const btn = sheetContent.querySelector('[data-action="cancel-login"]');
        if (btn) btn.addEventListener('click', () => confirmCancelLogin(deviceId));
    }
}

function refreshLoginScreen(deviceId) {
    const device = devices.find((item) => item.id === deviceId);
    if (device && deviceScreen.classList.contains('screen--active')) {
        deviceScreen.innerHTML = renderDeviceScreen(device);
    }
}

async function resumeLoginIfNeeded() {
    let deviceId = null;
    try {
        deviceId = localStorage.getItem(LOGIN_STORAGE_KEY);
    } catch (e) {
        return;
    }
    if (!deviceId) return;

    let data;
    try {
        data = await api(`/devices/${encodeURIComponent(deviceId)}/login`);
    } catch (error) {
        return;
    }
    if (!data || !RESUMABLE_LOGIN_STATUSES.includes(data.status)) {
        clearActiveLogin();
        return;
    }
    if (!devices.find((item) => item.id === deviceId)) {
        clearActiveLogin();
        return;
    }
    openDevice(deviceId);
    loginShownStatus = null;
    loginCancelling = false;
    handleLoginStatus(deviceId, data);
}

function confirmCancelLogin(deviceId) {
    haptic.notify('warning');
    stopLoginPoll();
    openSheet(`
        <h3 class="sheet__title">Отменить вход?</h3>
        <p class="sheet__sub">Вход в личный кабинет ещё не завершён. Точно отменить? На устройстве вернёмся на экран входа.</p>
        <div class="sheet__actions">
            <button type="button" class="btn btn--danger" data-action="confirm-cancel">Да, отменить</button>
            <button type="button" class="btn btn--primary" data-action="resume">Продолжить вход</button>
        </div>
    `, {
        full: true,
        onClose: () => resumeLoginPolling(deviceId),
    });
    sheetContent.querySelector('[data-action="confirm-cancel"]').addEventListener('click', () => cancelLoginConfirmed(deviceId));
    sheetContent.querySelector('[data-action="resume"]').addEventListener('click', () => {
        haptic.impact('light');
        resumeLoginPolling(deviceId);
    });
}

function resumeLoginPolling(deviceId) {
    loginShownStatus = null;
    tickLogin(deviceId);
}

async function cancelLoginConfirmed(deviceId) {
    haptic.impact('medium');
    loginCancelling = true;
    loginShownStatus = 'cancelling';
    clearActiveLogin();
    renderLoginProgress('Отменяю вход…', 'Возвращаюсь на экран входа', { cancel: false });
    try {
        await api(`/devices/${encodeURIComponent(deviceId)}/login/cancel`, { method: 'POST' });
    } catch (error) {
        /* даже при ошибке продолжаем опрашивать статус сессии */
    }
    scheduleLoginPoll(deviceId, 1200);
}

async function checkLoginState(deviceId) {
    const btn = deviceScreen.querySelector('[data-action="check-login"]');
    if (btn) btn.classList.add('is-loading');
    haptic.impact('medium');
    try {
        const data = await api(`/devices/${encodeURIComponent(deviceId)}/login/refresh`, { method: 'POST' });
        if (data.logged_in) {
            showLoginDetected(data);
        } else {
            haptic.notify('warning');
            showToast(loginStateMessage(data));
        }
    } catch (error) {
        haptic.notify('error');
        showToast(error.message || 'Не удалось проверить экран');
    } finally {
        const b = deviceScreen.querySelector('[data-action="check-login"]');
        if (b) b.classList.remove('is-loading');
    }
}

function loginStateMessage(data) {
    if (data.screen === 'login') return 'Открыт экран входа — вход не выполнен';
    return 'Не удалось определить экран';
}

function showLoginDetected(data) {
    haptic.notify('success');
    const stateEl = document.getElementById('loginState');
    if (stateEl) {
        const sub = data.screen === 'pin' ? 'Открыт экран код-пароля' : 'Открыт главный экран';
        stateEl.classList.add('login-state--done');
        stateEl.innerHTML = `
            <div class="login-state__icon login-state__icon--ok">${CHECK_ICON}</div>
            <p class="login-state__title">Вход выполнен</p>
            <p class="login-state__sub">${sub}</p>
        `;
    }
    showToast('Вход выполнен');
}

function startLoginFlow(deviceId) {
    haptic.impact('medium');
    stopLoginPoll();
    loginShownStatus = null;
    loginCancelling = false;
    openSheet(`
        <h3 class="sheet__title">Вход в личный кабинет</h3>
        <form class="form" id="loginForm" autocomplete="off">
            <label class="field">
                <span class="field__label">Номер телефона *</span>
                <div class="field__phone">
                    <span class="field__prefix">+7</span>
                    <input class="field__input field__input--phone" name="number" placeholder="900 000 00 00" inputmode="numeric" autocomplete="tel-national" maxlength="13" required>
                </div>
            </label>
            <label class="field">
                <span class="field__label">Код-пароль *</span>
                <input class="field__input" name="password" placeholder="4 цифры" inputmode="numeric" autocomplete="off" maxlength="8" required>
            </label>
            <div class="sheet__actions">
                <button type="submit" class="btn btn--primary">Войти</button>
                <button type="button" class="btn" data-action="cancel">Отмена</button>
            </div>
        </form>
    `, { full: true });
    const form = document.getElementById('loginForm');
    form.addEventListener('submit', (event) => onLoginSubmit(event, deviceId));
    form.elements.number.addEventListener('input', () => formatPhoneInput(form.elements.number));
    form.elements.password.addEventListener('input', () => {
        form.elements.password.value = form.elements.password.value.replace(/\D/g, '');
    });
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        haptic.impact('light');
        closeSheet();
    });
    setTimeout(() => form.elements.number.focus(), 80);
}

async function onLoginSubmit(event, deviceId) {
    event.preventDefault();
    const form = event.currentTarget;
    const number = form.elements.number.value.trim();
    const password = form.elements.password.value.trim();
    if (!number || !password) {
        showToast('Укажите номер и код-пароль');
        return;
    }

    loginShownStatus = 'running';
    loginCancelling = false;
    renderLoginProgress('Выполняю вход…', 'Ввожу номер, жму «Войти», закрываю запрос доступа', { deviceId });
    try {
        await api(`/devices/${encodeURIComponent(deviceId)}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ number, password }),
        });
        setActiveLogin(deviceId);
        scheduleLoginPoll(deviceId, 1200);
    } catch (error) {
        haptic.notify('error');
        clearActiveLogin();
        renderLoginError(deviceId, error.message || 'Не удалось начать вход');
    }
}

async function tickLogin(deviceId) {
    let data;
    try {
        data = await api(`/devices/${encodeURIComponent(deviceId)}/login`);
    } catch (error) {
        scheduleLoginPoll(deviceId, 2500);
        return;
    }
    handleLoginStatus(deviceId, data);
}

function handleLoginStatus(deviceId, data) {
    const terminal = ['done', 'error', 'cancelled', 'idle'];

    // Пока идёт отмена — держим экран «Отменяю…» и не даём промежуточным
    // статусам (awaiting_code и т.п.) перерисовать экран.
    if (loginCancelling && !terminal.includes(data.status)) {
        if (loginShownStatus !== 'cancelling') {
            loginShownStatus = 'cancelling';
            renderLoginProgress('Отменяю вход…', 'Возвращаюсь на экран входа', { cancel: false });
        }
        scheduleLoginPoll(deviceId, 1500);
        return;
    }

    switch (data.status) {
        case 'running':
            if (loginShownStatus !== 'running') {
                loginShownStatus = 'running';
                renderLoginProgress('Выполняю вход…', 'Ввожу номер, жму «Войти», закрываю запрос доступа', { deviceId });
            }
            scheduleLoginPoll(deviceId, 2000);
            break;
        case 'awaiting_code':
            if (loginShownStatus !== 'awaiting_code') {
                loginShownStatus = 'awaiting_code';
                haptic.notify('warning');
                renderCodeForm(deviceId, data);
            } else {
                updateCodeForm(data);
            }
            scheduleLoginPoll(deviceId, 2500);
            break;
        case 'verifying':
            if (loginShownStatus !== 'verifying') {
                loginShownStatus = 'verifying';
                renderLoginProgress('Проверяю код…', 'Ввожу код-пароль', { deviceId });
            }
            scheduleLoginPoll(deviceId, 2000);
            break;
        case 'cancelling':
            if (loginShownStatus !== 'cancelling') {
                loginShownStatus = 'cancelling';
                renderLoginProgress('Отменяю вход…', 'Возвращаюсь на экран входа', { cancel: false });
            }
            scheduleLoginPoll(deviceId, 1500);
            break;
        case 'done':
            stopLoginPoll();
            loginShownStatus = null;
            loginCancelling = false;
            clearActiveLogin();
            onLoginDone(deviceId, data.device);
            break;
        case 'cancelled':
            stopLoginPoll();
            loginShownStatus = null;
            loginCancelling = false;
            clearActiveLogin();
            closeSheet();
            haptic.notify('success');
            showToast('Вход отменён');
            refreshLoginScreen(deviceId);
            break;
        case 'error':
            stopLoginPoll();
            loginShownStatus = null;
            loginCancelling = false;
            clearActiveLogin();
            renderLoginError(deviceId, data.error);
            break;
        case 'idle':
            stopLoginPoll();
            loginShownStatus = null;
            loginCancelling = false;
            clearActiveLogin();
            closeSheet();
            break;
        default:
            scheduleLoginPoll(deviceId, 2000);
    }
}

function codeHintText(info) {
    const target = info.target || '';
    if (info.method === 'call') {
        return `Вам поступает звонок${target ? ' на ' + target : ''}. Отвечать не нужно — введите последние 6 цифр входящего номера.`;
    }
    if (info.method === 'sms') {
        return `Код отправлен по СМС${target ? ' на ' + target : ''}. Введите 6 цифр из сообщения.`;
    }
    return `Введите 6-значный код${target ? ', отправленный на ' + target : ''}.`;
}

const CODE_LENGTH = 6;

function renderCodeForm(deviceId, info) {
    const cells = Array.from({ length: CODE_LENGTH }, () => '<span class="code-cell"></span>').join('');
    openSheet(`
        <h3 class="sheet__title">Подтверждение входа</h3>
        <p class="sheet__sub" id="codeHint">${codeHintText(info)}</p>
        <form class="form" id="codeForm" autocomplete="off">
            <div class="field">
                <span class="field__label">Код *</span>
                <div class="code-input" id="codeInput">
                    <input class="code-input__field" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="${CODE_LENGTH}" autocomplete="one-time-code" required>
                    <div class="code-input__cells" aria-hidden="true">${cells}</div>
                </div>
            </div>
            <div class="sheet__actions">
                <button type="submit" class="btn btn--primary" id="codeSubmitBtn" disabled>Подтвердить</button>
                <button type="button" class="btn btn--ghost" id="resendBtn" data-action="resend" disabled>Отправить код заново</button>
                <button type="button" class="btn" data-action="cancel">Отменить</button>
            </div>
        </form>
    `, {
        full: true,
        onClose: () => confirmCancelLogin(deviceId),
    });
    const form = document.getElementById('codeForm');
    const input = form.elements.code;
    const wrap = document.getElementById('codeInput');
    const submitBtn = document.getElementById('codeSubmitBtn');

    const syncCells = () => {
        input.value = input.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
        const value = input.value;
        const filled = value.length;
        wrap.querySelectorAll('.code-cell').forEach((cell, i) => {
            cell.textContent = value[i] || '';
            cell.classList.toggle('code-cell--filled', i < filled);
            cell.classList.toggle('code-cell--active', i === filled && document.activeElement === input);
        });
        const complete = filled === CODE_LENGTH;
        wrap.classList.toggle('is-complete', complete);
        submitBtn.disabled = !complete;
    };

    form.addEventListener('submit', (event) => onCodeSubmit(event, deviceId));
    input.addEventListener('input', syncCells);
    input.addEventListener('focus', syncCells);
    input.addEventListener('blur', syncCells);
    wrap.addEventListener('click', () => input.focus());
    document.getElementById('resendBtn').addEventListener('click', () => onResend(deviceId));
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => confirmCancelLogin(deviceId));
    updateCodeForm(info);
    syncCells();
    setTimeout(() => input.focus(), 80);
}

function updateCodeForm(info) {
    const hintEl = document.getElementById('codeHint');
    if (hintEl) hintEl.textContent = codeHintText(info);
    const resendBtn = document.getElementById('resendBtn');
    if (resendBtn && !resendBtn.dataset.sending) {
        resendBtn.disabled = !info.resend_available;
    }
}

async function onResend(deviceId) {
    const btn = document.getElementById('resendBtn');
    if (btn && btn.disabled) return;
    if (btn) {
        btn.dataset.sending = '1';
        btn.disabled = true;
        btn.textContent = 'Отправляю…';
    }
    try {
        await api(`/devices/${encodeURIComponent(deviceId)}/login/resend`, { method: 'POST' });
        haptic.impact('medium');
        showToast('Запросил новый код');
    } catch (error) {
        haptic.notify('error');
        showToast(error.message || 'Не удалось отправить');
    } finally {
        if (btn) {
            delete btn.dataset.sending;
            btn.textContent = 'Отправить код заново';
            btn.disabled = true;
        }
    }
}

async function onCodeSubmit(event, deviceId) {
    event.preventDefault();
    const form = event.currentTarget;
    const code = form.elements.code.value.replace(/\D/g, '');
    if (code.length !== 6) {
        showToast('Нужно ввести 6 цифр');
        return;
    }
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Отправляю…';
    try {
        await api(`/devices/${encodeURIComponent(deviceId)}/login/code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        loginShownStatus = 'verifying';
        renderLoginProgress('Проверяю код…', 'Ввожу код-пароль', { deviceId });
        scheduleLoginPoll(deviceId, 1500);
    } catch (error) {
        haptic.notify('error');
        showToast(error.message || 'Не удалось отправить код');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Подтвердить';
    }
}

function onLoginDone(deviceId, device) {
    if (device) upsertDevice(normalizeDevice(device));
    haptic.notify('success');
    closeSheet();
    const updated = devices.find((item) => item.id === deviceId);
    if (updated && deviceScreen.classList.contains('screen--active')) {
        deviceScreen.innerHTML = renderDeviceScreen(updated);
    }
    renderDevices();
    showToast('ЛК добавлен');
}

function renderLoginError(deviceId, message) {
    haptic.notify('error');
    clearActiveLogin();
    openSheet(`
        <h3 class="sheet__title">Не удалось войти</h3>
        <p class="sheet__sub">${message || 'Ошибка входа'}</p>
        <div class="sheet__actions">
            <button type="button" class="btn btn--primary" data-action="retry">Повторить</button>
            <button type="button" class="btn" data-action="cancel">Закрыть</button>
        </div>
    `, { full: true });
    sheetContent.querySelector('[data-action="retry"]').addEventListener('click', () => startLoginFlow(deviceId));
    sheetContent.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        haptic.impact('light');
        closeSheet();
    });
}

document.getElementById('addDeviceBtn').addEventListener('click', openAddSheet);
document.getElementById('slotAdd').addEventListener('click', openAddSheet);
document.getElementById('statsBtn').addEventListener('click', () => showToast('Статистика скоро'));
document.getElementById('settingsBtn').addEventListener('click', () => showToast('Настройки скоро'));

/* ---------- Старт ---------- */

initTelegram();
loadDevices()
    .then(() => resumeLoginIfNeeded())
    .catch((error) => {
        deviceList.innerHTML = `<div class="empty">Не удалось загрузить девайсы.<br>${error.message}</div>`;
    });
