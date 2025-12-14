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