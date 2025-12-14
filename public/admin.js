// Languages defined in lang.js

let currentLang = 'en';
let peopleCache = [];
let tasksCache = [];
let chartInstances = {};
let chartIdCounter = 0;
let boardTitleMap = {};
let calendarView = 'week';
let calendarDate = new Date();
let localizedMonths = [];
let localizedWeekdays = [];
let levelingEnabled = true;
let taskSortable = null;
let settingsMode = 'unlocked';
let settingsChanged = false;
let settingsSaved = false;
let dateFormatting = '';
let authToken = localStorage.getItem('choresToken') || null;
let userPermission = 'write';
let loginEnabled = true;
let editTaskId = null;
let editTaskModal = null;
let customLevelTitles = {};
let personRewardsTarget = null;
let levelTitles = [];
let expandedFamilies = {}; // New state for tracking collapsed/expanded families

const personRewardsModalEl = document.getElementById('personRewardsModal');
const personRewardTitlesContainer = document.getElementById('personRewardTitlesContainer');
const personRewardTitleInputs = [];
if (personRewardTitlesContainer) {
  for (let i = 0; i < 10; i++) {
    const wrap = document.createElement('div');
    const lbl = document.createElement('label');
    lbl.className = 'form-label person-reward-title-label';
    lbl.setAttribute('for', `personRewardTitle${i}`);
    lbl.textContent = `Levels ${i * 10 + 1}-${(i + 1) * 10}`;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'form-control person-reward-title-input';
    inp.id = `personRewardTitle${i}`;
    wrap.appendChild(lbl);
    wrap.appendChild(inp);
    personRewardTitlesContainer.appendChild(wrap);
    personRewardTitleInputs.push(inp);
  }
}

function authHeaders() {
  return authToken ? { 'x-auth-token': authToken } : {};
}

function authFetch(url, options = {}) {
  options.headers = Object.assign({}, authHeaders(), options.headers || {});
  return fetch(url, options).then(res => {
    if (res.status === 401) {
      authToken = null;
      localStorage.removeItem('choresToken');
      checkLogin();
      throw new Error('Unauthorized');
    }
    return res;
  });
}

function setBackground(image) {
  const body = document.body;
  const loginDiv = document.getElementById('loginContainer');
  if (image) {
    const url = `img/${image}`;
    if (body) {
      body.style.backgroundImage = `url('${url}')`;
      body.style.backgroundSize = 'cover';
      body.style.backgroundRepeat = 'no-repeat';
      body.style.backgroundPosition = 'center';
    }
    if (loginDiv) {
      loginDiv.style.backgroundImage = `url('${url}')`;
    }
  } else {
    if (body) body.style.backgroundImage = '';
    if (loginDiv) loginDiv.style.backgroundImage = 'none';
  }
}

async function checkLogin() {
  const savedBg = localStorage.getItem('choresBackground');
  setBackground(savedBg === null ? 'forest.png' : savedBg);
  const app = document.getElementById('app');
  const loginDiv = document.getElementById('loginContainer');
  const res = await fetch('/api/login', { headers: authHeaders() });
  const data = await res.json();
  loginEnabled = data.loginRequired;
  if (!loginEnabled) {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.style.display = 'none';
    if (loginDiv) loginDiv.style.display = 'none';
    if (app) app.style.display = '';
    initApp();
    return;
  }
  if (data.loggedIn) {
    userPermission = data.permission || 'write';
    if (loginDiv) loginDiv.style.display = 'none';
    if (app) app.style.display = '';
    initApp();
    return;
  }
  if (loginDiv) loginDiv.style.display = '';
  const form = document.getElementById('loginForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('loginUser').value;
      const password = document.getElementById('loginPass').value;
      const resp = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const out = await resp.json();
      if (resp.ok && out.token) {
        authToken = out.token;
        localStorage.setItem('choresToken', authToken);
        userPermission = out.permission || 'write';
        loginDiv.style.display = 'none';
        if (app) app.style.display = '';
        initApp();
      } else {
        const err = document.getElementById('loginError');
        if (err) err.textContent = out.error || LANGUAGES[currentLang].loginError || 'Login failed';
      }
    });
  }
}

// ==========================
// API: Hämta inställningar från backend
// ==========================
async function fetchUserSettings() {
  try {
    const res = await authFetch('/api/settings');
    if (!res.ok) throw new Error('Failed fetching user settings');
    const data = await res.json();
    return data;
  } catch (e) {
    console.warn('Could not fetch user settings:', e);
    return {};
  }
}

// ==========================
// API: Spara språk till backend
// ==========================
async function saveUserLanguage(lang) {
  try {
    await authFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: lang })
    });
  } catch (e) {
    console.error('Failed saving user language:', e);
  }
}

// ==========================
// Init settings form and save handler
// ==========================
function initSettingsForm(settings) {
  const form = document.getElementById('settingsForm');
  if (!form) return;

  const showPast = document.getElementById('settingsShowPast');
  const textSize = document.getElementById('settingsTextSize');
  const dateFmt = document.getElementById('settingsDateFmt');
  const useAI = document.getElementById('settingsUseAI');
  const showAnalytics = document.getElementById('settingsShowAnalytics');
  const levelEnable = document.getElementById('settingsLevelEnable');
  const autoUpdate = document.getElementById('settingsAutoUpdate');
  const pushoverEnable = document.getElementById('settingsPushoverEnable');
  const reminderTime = document.getElementById('settingsReminderTime');
  const reminderContainer = reminderTime ? reminderTime.parentElement : null;
  const editRewardsBtn = document.getElementById('editRewardsBtn');
  const rewardsModalEl = document.getElementById('rewardsModal');
  const levelModeSelect = document.getElementById('rewardsLevelMode');
  const choresToMaxInput = document.getElementById('rewardsChoresToMax');
  const yearsInput = document.getElementById('rewardsYears');
  const perWeekInput = document.getElementById('rewardsPerWeek');
  const rewardTitlesContainer = document.getElementById('rewardTitlesContainer');
  const rewardTitleInputs = [];
  const backgroundSelect = document.getElementById('settingsBackground');

  if (showPast) showPast.checked = !!settings.showPast;
  if (textSize) textSize.value = settings.textMirrorSize || 'small';
  if (dateFmt) dateFmt.value = settings.dateFormatting || '';
  if (useAI) useAI.checked = settings.useAI !== false;
  if (showAnalytics) showAnalytics.checked = !!settings.showAnalyticsOnMirror;
  if (levelEnable) levelEnable.checked = settings.levelingEnabled !== false;
  if (autoUpdate) autoUpdate.checked = !!settings.autoUpdate;
  if (pushoverEnable) pushoverEnable.checked = !!settings.pushoverEnabled;
  if (reminderTime) reminderTime.value = settings.reminderTime || '';
  if (levelModeSelect) levelModeSelect.value = settings.leveling?.mode || 'years';
  if (choresToMaxInput) choresToMaxInput.value = settings.leveling?.choresToMaxLevel || '';
  if (yearsInput) yearsInput.value = settings.leveling?.yearsToMaxLevel || 3;
  if (perWeekInput) perWeekInput.value = settings.leveling?.choresPerWeekEstimate || 4;
  if (backgroundSelect) backgroundSelect.value = settings.background || 'forest.png';
  if (rewardTitlesContainer) {
    rewardTitlesContainer.innerHTML = '';
    const titles = Array.isArray(settings.levelTitles) ? settings.levelTitles : [];
    levelTitles = titles;
    for (let i = 0; i < 10; i++) {
      const wrap = document.createElement('div');
      const lbl = document.createElement('label');
      lbl.className = 'form-label reward-title-label';
      lbl.setAttribute('for', `rewardTitle${i}`);
      lbl.textContent = `${LANGUAGES[currentLang].levelRangeLabel || 'Levels'} ${i*10+1}-${(i+1)*10}`;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'form-control reward-title-input';
      inp.id = `rewardTitle${i}`;
      inp.value = titles[i] || '';
      wrap.appendChild(lbl);
      wrap.appendChild(inp);
      rewardTitlesContainer.appendChild(wrap);
      rewardTitleInputs.push(inp);
    }
  }

  const toggleRewardsBtn = () => {
    if (editRewardsBtn) editRewardsBtn.classList.toggle('d-none', !(levelEnable && levelEnable.checked));
  };
  if (levelEnable) {
    levelEnable.addEventListener('change', toggleRewardsBtn);
  }
  toggleRewardsBtn();

  const toggleLevelModeFields = () => {
    const mode = levelModeSelect ? levelModeSelect.value : 'years';
    const rewardsModal = rewardsModalEl;
    if (rewardsModal) {
      rewardsModal.querySelectorAll('.level-mode-years').forEach(el => el.classList.toggle('d-none', mode !== 'years'));
      rewardsModal.querySelectorAll('.level-mode-chores').forEach(el => el.classList.toggle('d-none', mode !== 'chores'));
    }
  };
  if (levelModeSelect) {
    levelModeSelect.addEventListener('change', () => {
      toggleLevelModeFields();
      settingsChanged = true;
    });
  }
  toggleLevelModeFields();

  const toggleReminderField = () => {
    const show = pushoverEnable && pushoverEnable.checked;
    if (reminderContainer) reminderContainer.classList.toggle('d-none', !show);
  };
  if (pushoverEnable) {
    pushoverEnable.addEventListener('change', toggleReminderField);
  }
  toggleReminderField();

  if (editRewardsBtn && rewardsModalEl) {
    editRewardsBtn.addEventListener('click', () => {
      renderPersonRewardsList();
      const modal = new bootstrap.Modal(rewardsModalEl);
      modal.show();
    });
  }
  const rewardsForm = document.getElementById('rewardsForm');
  if (rewardsForm && rewardsModalEl) {
    rewardsForm.addEventListener('submit', e => {
      e.preventDefault();
      const modal = bootstrap.Modal.getInstance(rewardsModalEl);
      if (modal) modal.hide();
    });
  }

  settingsChanged = false;
  settingsSaved = false;

  const inputs = [showPast, textSize, dateFmt, useAI, showAnalytics, levelEnable, autoUpdate, pushoverEnable, reminderTime, levelModeSelect, choresToMaxInput, yearsInput, perWeekInput, backgroundSelect, ...rewardTitleInputs];
  inputs.forEach(el => {
    if (el) {
      el.addEventListener('input', () => { settingsChanged = true; });
      el.addEventListener('change', () => { settingsChanged = true; });
    }
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    settingsSaved = true;
      const payload = {
        showPast: showPast.checked,
        textMirrorSize: textSize.value,
        dateFormatting: dateFmt.value,
        useAI: useAI.checked,
        showAnalyticsOnMirror: showAnalytics.checked,
        levelingEnabled: levelEnable.checked,
        autoUpdate: autoUpdate.checked,
        pushoverEnabled: pushoverEnable.checked,
        reminderTime: reminderTime.value,
        background: backgroundSelect.value,
        leveling: {
          mode: levelModeSelect ? levelModeSelect.value : 'years',
          choresToMaxLevel: parseFloat(choresToMaxInput?.value) || 0,
          yearsToMaxLevel: parseFloat(yearsInput.value) || 3,
          choresPerWeekEstimate: parseFloat(perWeekInput.value) || 4,
        },
        levelTitles: rewardTitleInputs.map(inp => inp.value)
      };
    try {
      const res = await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json();
        await applySettings(data.settings || payload);
        const instance = bootstrap.Modal.getInstance(document.getElementById('settingsModal'));
        if (instance) instance.hide();
      } else {
        const out = await res.json().catch(() => ({}));
        alert(out.error || 'Failed saving settings');
      }
    } catch (err) {
      console.error('Failed saving settings', err);
    }
  });
}

function updateBoardTitleMap() {
  boardTitleMap = { ...LANGUAGES[currentLang].chartOptions };
}

function setLanguage(lang) {
  if (!LANGUAGES[lang]) return;
  currentLang = lang;
  localStorage.setItem("mmm-chores-lang", lang);
  document.documentElement.setAttribute('lang', lang);

  const t = LANGUAGES[lang];

  localizedMonths = Array.from({ length: 12 }, (_, i) =>
    new Date(2000, i).toLocaleDateString(lang, { month: "short" })
  );
  localizedWeekdays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(2021, 5, 7 + i); // Monday based
    return d.toLocaleDateString(lang, { weekday: "short" });
  });

  document.querySelector(".hero h1").textContent = t.title;
  document.querySelector(".hero small").textContent = t.subtitle;

  // ... (Language mapping truncated for brevity - same as before) ...
  // [Rest of setLanguage function remains the same]
  const loginTitle = document.querySelector('#loginContainer h2');
  if (loginTitle) loginTitle.textContent = t.loginTitle || 'Login';
  // ...
  const footer = document.getElementById("footerText");
  if (footer) footer.textContent = t.footer;

  document.querySelectorAll("select").forEach(select => {
    const unassignedOption = Array.from(select.options).find(opt => opt.value === "");
    if (unassignedOption) unassignedOption.textContent = t.unassigned;
  });

  updateBoardTitleMap();
  renderPeople();
  renderTasks();
  renderCalendar();

  Object.entries(chartInstances).forEach(([id, chart]) => {
    const cardHeaderSpan = document.querySelector(`#${id}`).closest(".card").querySelector(".card-header span");
    if (cardHeaderSpan && boardTitleMap[chart.boardType]) {
      cardHeaderSpan.textContent = boardTitleMap[chart.boardType];
    }
  });
}

async function fetchPeople() {
  const res = await authFetch("/api/people");
  peopleCache = await res.json();
  renderPeople();
}

async function fetchTasks() {
  const res = await authFetch("/api/tasks");
  tasksCache = await res.json();
  // Backend sorts by family, we sort by deleted to keep logic consistent
  tasksCache.sort((a, b) => {
    if (a.deleted && !b.deleted) return 1;
    if (!a.deleted && b.deleted) return -1;
    return (a.order || 0) - (b.order || 0);
  });
  renderTasks();
  renderCalendar();
}

async function applySettings(newSettings) {
  // ... (Same as before) ...
  if (typeof newSettings.levelingEnabled === 'boolean') {
    levelingEnabled = newSettings.levelingEnabled;
  }
  if (newSettings.useAI !== undefined) {
    const aiButton = document.getElementById('btnAiGenerate');
    if (aiButton) aiButton.style.display = newSettings.useAI === false ? 'none' : '';
  }
  if (newSettings.dateFormatting !== undefined) {
    dateFormatting = newSettings.dateFormatting;
  }
  if (Array.isArray(newSettings.levelTitles)) {
    levelTitles = newSettings.levelTitles;
  }
  if (newSettings.background !== undefined) {
    setBackground(newSettings.background);
    localStorage.setItem('choresBackground', newSettings.background || '');
  }
  await fetchPeople();
  await fetchTasks();
}

// ... (renderPersonRewardsList, openPersonRewards, showPersonRewards same as before) ...
function openPersonRewards(person) {
  personRewardsTarget = person;
  const titles = customLevelTitles[person.name] || [];
  for (let i = 0; i < personRewardTitleInputs.length; i++) {
    personRewardTitleInputs[i].value = titles[i] || '';
  }
  const removeBtn = document.getElementById('personRewardsRemoveBtn');
  if (removeBtn) removeBtn.style.display = customLevelTitles[person.name] ? '' : 'none';
  const modalTitle = document.getElementById('personRewardsModalLabel');
  const t = LANGUAGES[currentLang];
  if (modalTitle) modalTitle.textContent = `${t.editRewardsButton || 'Edit Rewards'} - ${person.name}`;
  const modal = personRewardsModalEl ? new bootstrap.Modal(personRewardsModalEl) : null;
  if (modal) modal.show();
}

function showPersonRewards(person) {
  const list = document.getElementById('viewRewardsList');
  if (!list) return;
  list.innerHTML = '';
  const t = LANGUAGES[currentLang];
  const titles = (customLevelTitles[person.name] && customLevelTitles[person.name].length)
    ? customLevelTitles[person.name]
    : levelTitles;
  for (let i = 0; i < 10; i++) {
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between';
    const range = document.createElement('span');
    range.textContent = `${t.levelRangeLabel || 'Levels'} ${i * 10 + 1}-${(i + 1) * 10}`;
    const txt = document.createElement('span');
    txt.textContent = titles[i] || '';
    li.appendChild(range);
    li.appendChild(txt);
    list.appendChild(li);
  }
  const modalTitle = document.getElementById('viewRewardsModalLabel');
  if (modalTitle) modalTitle.textContent = `${t.viewRewardsButton || 'Rewards'} - ${person.name}`;
  const modalEl = document.getElementById('viewRewardsModal');
  const modal = modalEl ? new bootstrap.Modal(modalEl) : null;
  if (modal) modal.show();
}

function renderPersonRewardsList() {
  const list = document.getElementById('personRewardsList');
  if (!list) return;
  list.innerHTML = '';
  if (peopleCache.length === 0) {
    const li = document.createElement('li');
    li.className = 'list-group-item text-center text-muted';
    li.textContent = LANGUAGES[currentLang].noPeople;
    list.appendChild(li);
    return;
  }
  for (const person of peopleCache) {
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center';
    const span = document.createElement('span');
    span.textContent = person.name;
    li.appendChild(span);
    const btn = document.createElement('button');
    btn.className = 'btn btn-outline-secondary btn-sm';
    btn.textContent = LANGUAGES[currentLang].editRewardsButton || 'Edit Rewards';
    btn.onclick = () => openPersonRewards(person);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function renderPeople() {
  // ... (Same as before) ...
  const list = document.getElementById("peopleList");
  list.innerHTML = "";

  if (peopleCache.length === 0) {
    const li = document.createElement("li");
    li.className = "list-group-item text-center text-muted";
    li.textContent = LANGUAGES[currentLang].noPeople;
    list.appendChild(li);
    return;
  }

  for (const person of peopleCache) {
    const li = document.createElement("li");
    li.className = "list-group-item d-flex justify-content-between align-items-center";
    const info = document.createElement("span");
    info.textContent = person.name;
    if (levelingEnabled && person.level) {
      const small = document.createElement("small");
      small.className = "ms-2 text-muted";
      const titlePart = person.title ? ` - ${person.title}` : "";
      small.textContent = `lvl${person.level}${titlePart}`;
      info.appendChild(small);
    }

    li.appendChild(info);

    if (userPermission === 'write') {
      const actions = document.createElement('div');
      actions.className = 'btn-group btn-group-sm';
      if (levelingEnabled) {
        const viewBtn = document.createElement('button');
        viewBtn.className = 'btn btn-outline-secondary';
        viewBtn.title = LANGUAGES[currentLang].viewRewardsButton || 'Rewards';
        viewBtn.innerHTML = '<i class="bi bi-gift"></i>';
        viewBtn.onclick = () => showPersonRewards(person);
        actions.appendChild(viewBtn);
      }
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-outline-danger';
      delBtn.title = LANGUAGES[currentLang].remove;
      delBtn.innerHTML = '<i class="bi bi-trash"></i>';
      delBtn.onclick = () => deletePerson(person.id);
      actions.appendChild(delBtn);
      li.appendChild(actions);
    }
    list.appendChild(li);
  }
  const taskPerson = document.getElementById('taskPerson');
  const editPerson = document.getElementById('editTaskPerson');
  if (taskPerson) {
    taskPerson.innerHTML = '';
    taskPerson.add(new Option(LANGUAGES[currentLang].unassigned, ''));
    peopleCache.forEach(p => {
      taskPerson.add(new Option(p.name, p.id));
    });
  }
  if (editPerson) {
    editPerson.innerHTML = '';
    editPerson.add(new Option(LANGUAGES[currentLang].unassigned, ''));
    peopleCache.forEach(p => {
      editPerson.add(new Option(p.name, p.id));
    });
  }
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return dateStr;
  const [, yyyy, mm, dd] = match;

  let fmt =
    dateFormatting !== undefined && dateFormatting !== null
      ? dateFormatting
      : 'yyyy-mm-dd';

  if (fmt === '') return '';

  fmt = fmt.replace(/yyyy/gi, yyyy);
  fmt = fmt.replace(/mm/gi, mm);
  fmt = fmt.replace(/dd/gi, dd);

  fmt = fmt.replace(/YYYY/g, yyyy);
  fmt = fmt.replace(/MM/g, mm);
  fmt = fmt.replace(/DD/g, dd);

  return fmt;
}

// ==========================
// RENDER TASKS (UPDATED FOR FAMILIES)
// ==========================
function renderTasks() {
  const canWrite = userPermission === 'write';
  const list = document.getElementById("taskList");
  list.innerHTML = "";

  const visibleTasks = tasksCache.filter(t => !t.deleted);

  if (visibleTasks.length === 0) {
    const li = document.createElement("li");
    li.className = "list-group-item text-center text-muted";
    li.textContent = LANGUAGES[currentLang].noTasks;
    list.appendChild(li);
    return;
  }

  // 1. Group tasks into families
  const groups = [];
  let currentGroup = null;

  visibleTasks.forEach(t => {
    const root = t.rootId || t.id;
    if (currentGroup && currentGroup.root === root) {
      currentGroup.tasks.push(t);
    } else {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = { root: root, tasks: [t] };
    }
  });
  if (currentGroup) groups.push(currentGroup);

  // 2. Render Groups
  groups.forEach(g => {
    // If only 1 task in family, render simple row
    if (g.tasks.length === 1) {
      const li = createTaskRow(g.tasks[0], canWrite);
      // Ensure drag works for singleton by attaching dataset
      li.dataset.id = g.tasks[0].id; 
      list.appendChild(li);
    } 
    else {
      // Family Group
      const firstTask = g.tasks[0];
      const lastTask = g.tasks[g.tasks.length - 1];
      const rootId = g.root;
      
      const li = document.createElement('li');
      li.className = 'list-group-item p-0 border-0 mb-1';
      li.dataset.id = firstTask.id; // For Sortable to identify the group anchor

      // Header Row
      const header = document.createElement('div');
      header.className = 'd-flex align-items-center list-group-item list-group-item-secondary';
      
      // Toggle Button
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn btn-sm btn-link text-decoration-none text-dark p-0 me-2';
      const isExpanded = expandedFamilies[rootId];
      toggleBtn.innerHTML = isExpanded ? '<i class="bi bi-chevron-down"></i>' : '<i class="bi bi-chevron-right"></i>';
      toggleBtn.onclick = (e) => {
        e.stopPropagation();
        expandedFamilies[rootId] = !expandedFamilies[rootId];
        renderTasks(); // Re-render to update view
      };
      
      // Summary Text
      const info = document.createElement('div');
      info.className = 'flex-grow-1';
      const dateRange = `${formatDate(firstTask.date)} - ${formatDate(lastTask.date)}`;
      info.innerHTML = `<strong>${firstTask.name}</strong> <small class="text-muted">(${dateRange})</small>`;
      
      if (firstTask.recurring && firstTask.recurring !== 'none') {
        const recurText = LANGUAGES[currentLang].taskRecurring[firstTask.recurring] || firstTask.recurring;
        info.innerHTML += ` <span class="badge bg-info text-dark ms-1">${recurText}</span>`;
      }

      // Drag Handle for Family
      if (canWrite) {
        const dragHandle = document.createElement('button');
        dragHandle.className = 'btn btn-sm btn-outline-secondary drag-handle ms-2';
        dragHandle.innerHTML = '<i class="bi bi-list"></i>';
        header.appendChild(toggleBtn);
        header.appendChild(info);
        header.appendChild(dragHandle);
      } else {
        header.appendChild(toggleBtn);
        header.appendChild(info);
      }

      li.appendChild(header);

      // Children Container
      if (isExpanded) {
        const childrenUl = document.createElement('ul');
        childrenUl.className = 'list-group list-group-flush ms-4 border-start';
        g.tasks.forEach(t => {
          const childRow = createTaskRow(t, canWrite);
          // Remove drag handle from children to prevent dragging out of family
          const handle = childRow.querySelector('.drag-handle');
          if (handle) handle.remove(); 
          childrenUl.appendChild(childRow);
        });
        li.appendChild(childrenUl);
      }

      list.appendChild(li);
    }
  });

  // 3. Initialize Sortable on the Main List
  if (taskSortable) {
    taskSortable.destroy();
    taskSortable = null;
  }
  if (canWrite) {
    taskSortable = new Sortable(list, {
      handle: '.drag-handle',
      animation: 150,
      onEnd: async (evt) => {
        // We moved a "Group" (li.dataset.id = firstTask.id)
        // We need to tell backend: "Move family of [movedId] to index X"
        // But indices are tricky with collapsible items.
        // Easiest approach: Get the list of IDs from the *visual* order of the headers/singletons.
        
        const newOrderIds = [];
        list.childNodes.forEach(node => {
          if (node.dataset && node.dataset.id) {
            newOrderIds.push(parseInt(node.dataset.id));
          }
        });

        // We find which one was moved
        const itemEl = evt.item;
        const movedId = parseInt(itemEl.dataset.id);

        await authFetch('/api/tasks/reorder', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            ids: newOrderIds,
            movedId: movedId 
          })
        });
        
        await fetchTasks();
      }
    });
  }
}

// Helper to create a standard task row
function createTaskRow(task, canWrite) {
  const li = document.createElement("li");
  li.className = "list-group-item d-flex align-items-center";
  li.dataset.id = task.id;

  const left = document.createElement("div");
  left.className = "d-flex align-items-center";

  const actions = document.createElement("div");
  actions.className = "d-flex align-items-center ms-auto gap-1";

  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.checked = task.done;
  chk.className = "form-check-input me-3";
  if (canWrite) {
    chk.addEventListener("change", async () => {
      const updateObj = { done: chk.checked };
      const now = new Date();
      const iso = now.toISOString();
      const pad = n => n.toString().padStart(2, "0");
      const stamp = (prefix) => (
        prefix +
        pad(now.getMonth() + 1) +
        pad(now.getDate()) +
        pad(now.getHours()) +
        pad(now.getMinutes())
      );

      if (chk.checked) {
        updateObj.finished = iso;
        updateObj.finishedShort = stamp("F");
      } else {
        updateObj.finished = null;
        updateObj.finishedShort = null;
      }
      await updateTask(task.id, updateObj);
    });
  } else {
    chk.disabled = true;
  }

  const span = document.createElement("span");
  const formatted = formatDate(task.date);
  span.innerHTML = `<strong>${task.name}</strong>`;
  if (formatted) {
    span.innerHTML += ` <small class="task-date">(${formatted})</small>`;
  }
  // Only show recurring badge if it's a Singleton (families show it in header)
  // But this helper doesn't know if it's a singleton.
  // We can leave it, or handle it via CSS/JS logic. 
  // For now, let's leave it, redundancy is okay or we can hide it via css in family view.
  if (task.recurring && task.recurring !== "none") {
    const recurText = LANGUAGES[currentLang].taskRecurring[task.recurring] || task.recurring;
    span.innerHTML += ` <span class="badge bg-info text-dark ms-1">${recurText}</span>`;
  }
  
  if (task.done) span.classList.add("task-done");
  const person = peopleCache.find(p => p.id === task.assignedTo);
  const personName = person ? person.name : LANGUAGES[currentLang].unassigned;
  span.innerHTML += ` - ${personName}`;

  left.appendChild(chk);
  left.appendChild(span);

  if (canWrite) {
    const del = document.createElement("button");
    del.className = "btn btn-sm btn-outline-danger";
    del.title = LANGUAGES[currentLang].remove;
    del.innerHTML = '<i class="bi bi-trash"></i>';
    del.addEventListener("click", () => deleteTask(task.id));

    const dragBtn = document.createElement("button");
    dragBtn.className = "btn btn-sm btn-outline-secondary drag-handle";
    dragBtn.innerHTML = '<i class="bi bi-list"></i>';

    if (!task.done) {
      const edit = document.createElement("button");
      edit.className = "btn btn-sm btn-outline-secondary";
      edit.title = LANGUAGES[currentLang].edit;
      edit.innerHTML = '<i class="bi bi-pencil"></i>';
      edit.addEventListener("click", () => openEditModal(task));
      actions.appendChild(edit);
    }
    actions.appendChild(del);
    actions.appendChild(dragBtn);
  }

  if (actions.childElementCount > 0) {
    li.append(left, actions);
  } else {
    li.append(left);
  }
  return li;
}

// ... (Rest of file: openEditModal, getWeekNumber, renderCalendar, CRUD handlers, Charts, etc. same as original) ...
// The rest of the file logic is identical to your provided file, just assume it's appended here.
// For brevity, I'm not repeating lines 690 to end unless necessary, but you should keep them.

function openEditModal(task) {
  editTaskId = task.id;
  const nameInput = document.getElementById('editTaskName');
  const dateInput = document.getElementById('editTaskDate');
  const personSelect = document.getElementById('editTaskPerson');
  if (nameInput) nameInput.value = task.name;
  if (dateInput) dateInput.value = task.date || '';
  if (personSelect) personSelect.value = task.assignedTo || '';
  if (!editTaskModal) {
    const modalEl = document.getElementById('editTaskModal');
    if (modalEl) editTaskModal = new bootstrap.Modal(modalEl);
  }
  if (editTaskModal) editTaskModal.show();
}

function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

function renderCalendar() {
  const container = document.getElementById("taskCalendar");
  if (!container) return;

  const undone = tasksCache.filter(t => !t.deleted && !t.done);
  if (undone.length === 0) {
    container.innerHTML = `<p class="text-center text-muted">${LANGUAGES[currentLang].noTasks}</p>`;
    return;
  }

  const tasksByDate = {};
  undone.forEach(t => {
    if (!tasksByDate[t.date]) tasksByDate[t.date] = [];
    tasksByDate[t.date].push(t);
  });

  const weekdays = localizedWeekdays.length ? localizedWeekdays : ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const pad = n => String(n).padStart(2, '0');

  let html = `
    <div class="d-flex justify-content-between align-items-center mb-2">
      <button class="btn btn-sm btn-outline-secondary" id="calPrev">&lt;</button>
      <span id="calTitle" class="fw-bold"></span>
      <div class="d-flex gap-2">
        <button class="btn btn-sm btn-outline-secondary" id="calToggle">${calendarView === 'week' ? LANGUAGES[currentLang].monthLabel : LANGUAGES[currentLang].weekLabel}</button>
        <button class="btn btn-sm btn-outline-secondary" id="calNext">&gt;</button>
      </div>
    </div>`;

  html += '<table class="table table-bordered table-sm">';
  html += '<thead><tr>' + weekdays.map(d => `<th class="text-center">${d}</th>`).join('') + '</tr></thead><tbody>';

  if (calendarView === 'month') {
    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();
    const first = new Date(year, month, 1);
    const startDay = (first.getDay() + 6) % 7; // Monday as first day
    const last = new Date(year, month + 1, 0);
    const totalDays = last.getDate();
    let day = 1;
    for (let w = 0; w < 6 && day <= totalDays; w++) {
      html += '<tr>';
      for (let d = 0; d < 7; d++) {
        if ((w === 0 && d < startDay) || day > totalDays) {
          html += '<td></td>';
        } else {
          const dateStr = `${year}-${pad(month + 1)}-${pad(day)}`;
          const arr = tasksByDate[dateStr] || [];
          html += `<td class="align-top"><div><strong>${day}</strong></div>`;
          arr.forEach(t => { html += `<div class="small">${t.name}</div>`; });
          html += '</td>';
          day++;
        }
      }
      html += '</tr>';
    }
  } else {
    const start = new Date(calendarDate);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    html += '<tr>';
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const arr = tasksByDate[dateStr] || [];
      html += `<td class="align-top"><div><strong>${d.getDate()}</strong></div>`;
      arr.forEach(t => { html += `<div class="small">${t.name}</div>`; });
      html += '</td>';
    }
    html += '</tr>';
  }

  html += '</tbody></table>';
  container.innerHTML = html;

  const titleEl = document.getElementById('calTitle');
  if (calendarView === 'month') {
    const months = localizedMonths.length ? localizedMonths : ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    titleEl.textContent = `${months[calendarDate.getMonth()]} ${calendarDate.getFullYear()}`;
  } else {
    titleEl.textContent = `${LANGUAGES[currentLang].weekLabel} ${getWeekNumber(calendarDate)} ${calendarDate.getFullYear()}`;
  }

  document.getElementById('calPrev').onclick = () => {
    if (calendarView === 'month') {
      calendarDate.setMonth(calendarDate.getMonth() - 1);
    } else {
      calendarDate.setDate(calendarDate.getDate() - 7);
    }
    renderCalendar();
  };
  document.getElementById('calNext').onclick = () => {
    if (calendarView === 'month') {
      calendarDate.setMonth(calendarDate.getMonth() + 1);
    } else {
      calendarDate.setDate(calendarDate.getDate() + 7);
    }
    renderCalendar();
  };
  document.getElementById('calToggle').onclick = () => {
    calendarView = calendarView === 'week' ? 'month' : 'week';
    renderCalendar();
  };
}

// ==========================
// CRUD Handlers
// ==========================
const personRewardsForm = document.getElementById('personRewardsForm');
if (personRewardsForm) {
  personRewardsForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (!personRewardsTarget) return;
    const titles = personRewardTitleInputs.map(inp => inp.value);
    if (titles.every(t => !t.trim())) {
      delete customLevelTitles[personRewardsTarget.name];
    } else {
      customLevelTitles[personRewardsTarget.name] = titles;
    }
    try {
      await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customLevelTitles })
      });
      const modal = bootstrap.Modal.getInstance(personRewardsModalEl);
      if (modal) modal.hide();
      await fetchPeople();
    } catch (err) {
      console.error('Failed saving custom rewards', err);
    }
  });
}
const personRewardsRemoveBtn = document.getElementById('personRewardsRemoveBtn');
if (personRewardsRemoveBtn) {
  personRewardsRemoveBtn.addEventListener('click', async () => {
    if (!personRewardsTarget) return;
    delete customLevelTitles[personRewardsTarget.name];
    try {
      await authFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customLevelTitles })
      });
      const modal = bootstrap.Modal.getInstance(personRewardsModalEl);
      if (modal) modal.hide();
      await fetchPeople();
    } catch (err) {
      console.error('Failed removing custom rewards', err);
    }
  });
}

document.getElementById("personForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = document.getElementById("personName").value.trim();
  if (!name) return;
  await authFetch("/api/people", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  e.target.reset();
  await fetchPeople();
  await fetchTasks();
});

document.getElementById("taskForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = document.getElementById("taskName").value.trim();
  let date = document.getElementById("taskDate").value;
  const recurring = document.getElementById("taskRecurring").value;
  const assigned = document.getElementById("taskPerson").value;
  if (!name) return;
  if (!date) date = new Date().toISOString().split("T")[0];

  const now = new Date();
  const iso = now.toISOString();
  const pad = n => n.toString().padStart(2, "0");
  const stamp = (prefix) => (
    prefix +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes())
  );

  await authFetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      date,
      recurring,
      assignedTo: assigned ? parseInt(assigned) : null,
      created: iso,
      createdShort: stamp("C")
    })
  });
  e.target.reset();
  await fetchTasks();
});

document.getElementById('editTaskForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = document.getElementById('editTaskName').value.trim();
  const date = document.getElementById('editTaskDate').value;
  const assigned = document.getElementById('editTaskPerson').value;
  await updateTask(editTaskId, {
    name,
    date,
    assignedTo: assigned ? parseInt(assigned) : null
  });
  if (editTaskModal) editTaskModal.hide();
  editTaskId = null;
});

async function updateTask(id, changes) {
  Object.keys(changes).forEach(key => {
    if (changes[key] === null) changes[key] = undefined;
  });
  await authFetch(`/api/tasks/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes)
  });
  await fetchTasks();
}

async function deletePerson(id) {
  await authFetch(`/api/people/${id}`, { method: "DELETE" });
  await fetchPeople();
  await fetchTasks();
}

async function deleteTask(id) {
  await authFetch(`/api/tasks/${id}`, { method: "DELETE" });
  await fetchTasks();
}


// ==========================
// Analytics Board Persistence
// ==========================
async function fetchSavedBoards() {
  try {
    const res = await authFetch('/api/analyticsBoards');
    if (!res.ok) throw new Error('Failed fetching saved boards');
    return await res.json();
  } catch (e) {
    console.warn('No saved analytics boards or error:', e);
    return [];
  }
}

async function saveBoards(typesArray) {
  try {
    await authFetch('/api/analyticsBoards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(typesArray)
    });
  } catch (e) {
    console.error('Failed saving analytics boards:', e);
  }
}

function getCurrentBoardTypes() {
  return Array.from(document.querySelectorAll('#analyticsContainer .card-header span'))
    .map(span => {
      const text = span.textContent.trim();
      for (const [key, title] of Object.entries(boardTitleMap)) {
        if (title === text) return key;
      }
      return null;
    }).filter(Boolean);
}

// ==========================
// Analytics Chart Handling
// ==========================
document.getElementById("addChartSelect").addEventListener("change", function () {
  const value = this.value;
  if (!value) return;
  addChart(value);
  this.value = "";
});

function addChart(type) {
  if (getCurrentBoardTypes().includes(type)) return; // no duplicates

  const container = document.getElementById("analyticsContainer");
  const card = document.createElement("div");
  card.className = "col-md-6";

  const cardId = `chart-${chartIdCounter++}`;
  card.innerHTML = `
    <div class="card card-shadow h-100">
      <div class="card-header d-flex justify-content-between align-items-center">
        <span>${boardTitleMap[type]}</span>
        <button class="btn btn-sm btn-outline-danger remove-widget" title="${LANGUAGES[currentLang].remove}">&times;</button>
      </div>
      <div class="card-body"><canvas id="${cardId}"></canvas></div>
    </div>
  `;

  container.appendChild(card);
  chartInstances[cardId] = renderChart(cardId, type);

  saveBoards(getCurrentBoardTypes());

  card.querySelector(".remove-widget").addEventListener("click", () => {
    chartInstances[cardId].destroy();
    delete chartInstances[cardId];
    card.remove();
    saveBoards(getCurrentBoardTypes());
  });
}

function renderChart(canvasId, type) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  let data = { labels: [], datasets: [] };
  let options = { scales: { y: { beginAtZero: true } } };
  let chartType = "bar";

  const filteredTasks = (filterFn) => tasksCache.filter(t => !(t.deleted && !t.done) && filterFn(t));

  switch (type) {
    case "weekly": {
      const today = new Date();
      const labels = [];
      const counts = [];
      for (let i = 3; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i * 7);
        labels.push(d.toISOString().split("T")[0]);
        const c = filteredTasks(t => {
          const td = new Date(t.date);
          return t.done && ((today - td) / 86400000) >= i * 7 && ((today - td) / 86400000) < (i + 1) * 7;
        }).length;
        counts.push(c);
      }
      data = {
        labels,
        datasets: [{
          label: LANGUAGES[currentLang].chartLabels.completedTasks,
          data: counts,
          backgroundColor: "rgba(75,192,192,0.5)"
        }]
      };
      break;
    }

    case "weekdays": {
      chartType = "pie";
      const labels = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
      const dataArr = [0,0,0,0,0,0,0];
      filteredTasks(t => true).forEach(t => {
        const idx = (new Date(t.date).getDay() + 6) % 7;
        dataArr[idx]++;
      });
      data = {
        labels,
        datasets: [{
          data: dataArr,
          backgroundColor: [
            "#FF6384","#36A2EB","#FFCE56","#4BC0C0","#9966FF","#FF9F40","#C9CBCF"
          ]
        }]
      };
      options = {};
      break;
    }

    case "perPerson": {
      const labels = peopleCache.map(p => p.name);
      const counts = peopleCache.map(p =>
        filteredTasks(t => t.assignedTo === p.id).length
      );
      data = {
        labels,
        datasets: [{
          label: LANGUAGES[currentLang].chartLabels.unfinishedTasks,
          data: counts,
          backgroundColor: "rgba(153,102,255,0.5)"
        }]
      };
      break;
    }

    case "perPersonFinished": {
      const labels = peopleCache.map(p => p.name);
      const counts = peopleCache.map(p =>
        filteredTasks(t => t.assignedTo === p.id && t.done).length
      );
      data = {
        labels,
        datasets: [{
          label: LANGUAGES[currentLang].chartOptions.perPersonFinished,
          data: counts,
          backgroundColor: "rgba(75,192,192,0.5)"
        }]
      };
      break;
    }

    case "perPersonFinishedWeek": {
      const now = new Date();
      const start = new Date(now);
      start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      start.setHours(0,0,0,0);
      const end = new Date(start);
      end.setDate(start.getDate() + 7);
      const labels = peopleCache.map(p => p.name);
      const counts = peopleCache.map(p =>
        filteredTasks(t => {
          if (!t.done || t.assignedTo !== p.id) return false;
          const d = new Date(t.date);
          return d >= start && d < end;
        }).length
      );
      data = {
        labels,
        datasets: [{
          label: LANGUAGES[currentLang].chartOptions.perPersonFinishedWeek,
          data: counts,
          backgroundColor: "rgba(75,192,192,0.5)"
        }]
      };
      break;
    }

    case "perPersonUnfinished": {
      const labels = peopleCache.map(p => p.name);
      const counts = peopleCache.map(p =>
        filteredTasks(t => t.assignedTo === p.id && !t.done).length
      );
      data = {
        labels,
        datasets: [{
          label: LANGUAGES[currentLang].chartOptions.perPersonUnfinished,
          data: counts,
          backgroundColor: "rgba(255,99,132,0.5)"
        }]
      };
      break;
    }

    case "perPersonUnfinishedWeek": {
      const now = new Date();
      const start = new Date(now);
      start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      start.setHours(0,0,0,0);
      const end = new Date(start);
      end.setDate(start.getDate() + 7);
      const labels = peopleCache.map(p => p.name);
      const counts = peopleCache.map(p =>
        filteredTasks(t => {
          if (t.done || t.assignedTo !== p.id) return false;
          const d = new Date(t.date);
          return d >= start && d < end;
        }).length
      );
      data = {
        labels,
        datasets: [{
          label: LANGUAGES[currentLang].chartOptions.perPersonUnfinishedWeek,
          data: counts,
          backgroundColor: "rgba(255,99,132,0.5)"
        }]
      };
      break;
    }

    case "taskmaster": {
      const now = new Date();
      const labels = peopleCache.map(p => p.name);
      const counts = peopleCache.map(p =>
        tasksCache.filter(t => {
          const d = new Date(t.date);
          return t.done && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() && t.assignedTo === p.id;
        }).length
      );
      data = {
        labels,
        datasets: [{
          label: LANGUAGES[currentLang].chartOptions.taskmaster,
          data: counts,
          backgroundColor: "rgba(255,159,64,0.5)"
        }]
      };
      break;
    }

    case "lazyLegends": {
      const labels = peopleCache.map(p => p.name);
      const counts = peopleCache.map(p =>
        filteredTasks(t => t.assignedTo === p.id && !t.done).length
      );
      data = {
        labels,
        datasets: [{
          label: LANGUAGES[currentLang].chartOptions.lazyLegends,
          data: counts,
          backgroundColor: "rgba(255,99,132,0.5)"
        }]
      };
      break;
    }

    case "speedDemons": {
      const labels = peopleCache.map(p => p.name);
      const avgDays = peopleCache.map(p => {
        const times = filteredTasks(t => t.assignedTo === p.id && t.done && t.finished && t.assignedDate)
          .map(t => {
            const dDone = new Date(t.finished);
            const dAssigned = new Date(t.assignedDate);
            return (dDone - dAssigned) / (1000*60*60*24);
          });
        if (times.length === 0) return 0;
        return times.reduce((a,b) => a+b, 0) / times.length;
      });
      data = {
        labels,
        datasets: [{
          label: LANGUAGES[currentLang].chartOptions.speedDemons,
          data: avgDays,
          backgroundColor: "rgba(54,162,235,0.5)"
        }]
      };
      break;
    }

    case "weekendWarriors": {
      const labels = peopleCache.map(p => p.name);
      const counts = peopleCache.map(p =>
        filteredTasks(t => {
          if (!t.done || t.assignedTo !== p.id) return false;
          const d = new Date(t.date);
          return d.getDay() === 0 || d.getDay() === 6;
        }).length
      );
      data = {
        labels,
        datasets: [{
          label: LANGUAGES[currentLang].chartOptions.weekendWarriors,
          data: counts,
          backgroundColor: "rgba(255,206,86,0.5)"
        }]
      };
      break;
    }

    case "slacker9000": {
      const labels = peopleCache.map(p => p.name);
      const ages = peopleCache.map(p => {
        const openTasks = filteredTasks(t => t.assignedTo === p.id && !t.done && t.assignedDate);
        if (openTasks.length === 0) return 0;
        const now = new Date();
        return Math.max(...openTasks.map(t => (now - new Date(t.assignedDate)) / (1000*60*60*24)));
      });
      data = {
        labels,
        datasets: [{
          label: LANGUAGES[currentLang].chartOptions.slacker9000,
          data: ages,
          backgroundColor: "rgba(153,102,255,0.5)"
        }]
      };
      break;
    }

    default:
      data = { labels: [], datasets: [] };
      break;
  }

  const chart = new Chart(ctx, { type: chartType, data, options });
  chart.boardType = type;
  return chart;
}

// ==========================
// Theme, Språk och Init
// ==========================
function updateAllCharts() {
  for (const [id, chart] of Object.entries(chartInstances)) {
    const type = chart.boardType || "weekly";
  }
}

const root = document.documentElement;
const themeBtn = document.getElementById("themeToggle");
const themeIcon = document.getElementById("themeIcon");
const STORAGE_KEY = "mmm-chores-theme";

const savedTheme = localStorage.getItem(STORAGE_KEY) || "light";
root.setAttribute("data-theme", savedTheme);
setIcon(savedTheme);

themeBtn.addEventListener("click", () => {
  const current = root.getAttribute("data-theme");
  const theme = current === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", theme);
  localStorage.setItem(STORAGE_KEY, theme);
  setIcon(theme);
});

function setIcon(theme) {
  themeIcon.className = theme === "dark"
    ? "bi bi-moon-stars-fill"
    : "bi bi-brightness-high-fill";
}

async function initApp() {
  const userSettings = await fetchUserSettings();
  customLevelTitles = userSettings.customLevelTitles || {};
  if (userPermission !== 'write') {
    const personForm = document.getElementById('personForm');
    if (personForm) personForm.style.display = 'none';
    const taskForm = document.getElementById('taskForm');
    if (taskForm) taskForm.style.display = 'none';
  }
  if (typeof userSettings.levelingEnabled === "boolean") {
    levelingEnabled = userSettings.levelingEnabled;
  }
  if (userSettings.settings) {
    settingsMode = userSettings.settings;
  }
  if (userSettings.language && LANGUAGES[userSettings.language]) {
    currentLang = userSettings.language;
  } else {
    currentLang = localStorage.getItem("mmm-chores-lang") || 'en';
  }
  dateFormatting = userSettings.dateFormatting || '';

  const selector = document.createElement("select");
  selector.className = "language-select";
  Object.keys(LANGUAGES).forEach(lang => {
    const opt = document.createElement("option");
    opt.value = lang;
    opt.textContent = lang.toUpperCase();
    if (lang === currentLang) opt.selected = true;
    selector.appendChild(opt);
  });
  selector.addEventListener("change", async e => {
    const newLang = e.target.value;
    setLanguage(newLang);
    await saveUserLanguage(newLang);
  });

  const controls = document.querySelector(".top-controls");
  if (controls) {
    controls.appendChild(selector);
  } else {
    document.body.appendChild(selector);
  }

  const aiButton = document.getElementById("btnAiGenerate");
  if (aiButton && userSettings.useAI === false) {
    aiButton.style.display = "none";
  }

  const logoutBtn = document.getElementById('logoutBtn');
  if (!loginEnabled) {
    if (logoutBtn) logoutBtn.style.display = 'none';
  } else if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try { await authFetch('/api/logout', { method: 'POST' }); } catch (e) {}
      localStorage.removeItem('choresToken');
      window.location.reload();
    });
  }

  initSettingsForm(userSettings);

  setLanguage(currentLang);
  await applySettings(userSettings);

  const savedBoards = await fetchSavedBoards();
    if (savedBoards.length) {
      savedBoards.forEach(type => addChart(type));
    }

  const settingsBtn = document.getElementById("settingsBtn");
  const settingsModalEl = document.getElementById("settingsModal");
  const settingsForm = document.getElementById("settingsForm");
  const lockedMsg = document.getElementById("settingsLockedMsg");
  const modal = settingsModalEl ? new bootstrap.Modal(settingsModalEl) : null;
  if (settingsBtn && modal) {
    settingsBtn.addEventListener('click', () => {
      settingsChanged = false;
      settingsSaved = false;
      if (settingsMode === 'unlocked') {
        if (lockedMsg) lockedMsg.classList.add('d-none');
        if (settingsForm) settingsForm.classList.remove('d-none');
        modal.show();
        return;
      }

      if (/^\d{6}$/.test(settingsMode)) {
        const pin = prompt(LANGUAGES[currentLang].settingsEnterPin);
        if (pin === settingsMode) {
          settingsMode = 'unlocked';
          if (lockedMsg) lockedMsg.classList.add('d-none');
          if (settingsForm) settingsForm.classList.remove('d-none');
        } else {
          if (lockedMsg) {
            lockedMsg.textContent = LANGUAGES[currentLang].settingsWrongPin;
            lockedMsg.classList.remove('d-none');
          }
          if (settingsForm) settingsForm.classList.add('d-none');
        }
        modal.show();
        return;
      }

      if (lockedMsg) {
        lockedMsg.textContent = LANGUAGES[currentLang].settingsLocked;
        lockedMsg.classList.remove('d-none');
      }
      if (settingsForm) settingsForm.classList.add('d-none');
      modal.show();
    });
  }

  if (settingsModalEl) {
    settingsModalEl.addEventListener('hidden.bs.modal', () => {
      if (!settingsSaved && settingsChanged) {
        window.location.reload();
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  currentLang = localStorage.getItem('mmm-chores-lang') || currentLang;
  setLanguage(currentLang);
  checkLogin();
});

// ==========================
// ====== AI GENERATE =======
// ==========================

// Lägg till denna <button> i din HTML, t.ex. under tasklist:
// <button id="btnAiGenerate" class="btn btn-outline-primary mb-3" type="button">
//   <i class="bi bi-stars me-1"></i> AI Generate
// </button>
// <div id="toastContainer" style="position:fixed;top:20px;right:20px;z-index:10000;"></div>

// Toast/notification utility
function showToast(msg, type = "danger", duration = 4000) {
  let container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast align-items-center text-bg-${type} border-0 show`;
  toast.style.minWidth = "200px";
  toast.role = "alert";
  toast.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${msg}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
  toast.querySelector("button").onclick = () => toast.remove();
}

// AI Generate button handler
const aiBtn = document.getElementById("btnAiGenerate");
if (aiBtn) {
  aiBtn.onclick = async function () {
    aiBtn.disabled = true;
    aiBtn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>AI...`;

    try {
      const res = await authFetch('/api/ai-generate', { method: "POST" });
      const data = await res.json();

      if (!data.success) {
        showToast(data.error || "AI generation failed.", "danger", 7000);
      } else {
        showToast(`AI generated ${data.count} tasks!`, "success", 4000);
        await fetchTasks();
      }
    } catch (e) {
      showToast("AI generation failed. Server error.", "danger", 7000);
    } finally {
      aiBtn.disabled = false;
      aiBtn.innerHTML = `<i class="bi bi-stars me-1"></i> ${LANGUAGES[currentLang].aiGenerateButton}`;
    }
  };
}