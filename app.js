/**
 * 정보보호관리 법과목 모의고사 웹 애플리케이션 (418문항 비복원 전수 순회 + PC/스마트폰 클라우드 연동)
 */

const STORAGE_KEY = 'ism_law_exam_state_v1';
const SYNC_CONFIG_KEY = 'ism_law_sync_config_v1';
const THEME_KEY = 'ism_law_theme_v1';
const GIST_FILENAME = 'ism_law_exam_state.json';

let db = {
  totalQuestions: 0,
  tree: [],
  questions: [],
  byId: new Map(),
  allLeafScopes: [],
};

let appState = {
  version: 1,
  updatedAt: 0,
  cycle: 1,
  round: 1,
  countMode: '5-6', // '5-6' | '5' | '6'
  selectedScopes: null, // null이면 전체 범위 선택, 배열이면 선택된 scopeKey 목록
  seenIds: [], // 현재 회독에서 출제 완료된 대문항 ID 목록
  activeExam: null, // 현재 진행 중인 모의고사 { round, createdAt, questionIds, drafts, checkedRubrics, openAnswers }
  history: [], // 완료한 회차 기록 [{ round, cycle, completedAt, questionIds, earnedPoints, totalPoints }]
};

// 범위 설정 모달 내 임시 선택 상태
let tempSelectedScopes = new Set();
let activeHistoryTab = 'rounds';

// 타이머 상태
let timerInterval = null;
let timerSeconds = 0;
let timerRunning = false;

// 클라우드 동기화 상태
let syncConfig = null; // { gistId, token }
let syncDebounceTimer = null;
let isSyncing = false;
let deferredInstallPrompt = null;

/* =========================================================
 * 초기화 및 데이터 로드
 * ========================================================= */
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  initPwa();
  checkUrlSyncPairing();
  loadSyncConfig();
  loadLocalState();
  bindEvents();

  try {
    const res = await fetch('data/questions.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    initDatabase(data);

    // 클라우드 연동이 설정되어 있으면 원격 상태를 먼저 확인·병합
    if (syncConfig && syncConfig.gistId && syncConfig.token) {
      await pullFromCloud(true);
    }

    // 진행 중인 시험지가 없으면 첫 모의고사 자동 생성
    if (!appState.activeExam || !Array.isArray(appState.activeExam.questionIds) || appState.activeExam.questionIds.length === 0) {
      drawNewExam(false);
    } else {
      renderAll();
    }
  } catch (err) {
    console.error(err);
    document.getElementById('examContainer').innerHTML = `
      <div class="card question-card">
        <h3>⚠️ 문제은행 데이터를 불러오지 못했습니다.</h3>
        <p>${escapeHtml(err.message)}</p>
      </div>
    `;
  }
});

function initDatabase(data) {
  db.totalQuestions = data.totalQuestions;
  db.tree = data.tree;
  db.questions = data.questions;
  db.byId.clear();
  for (const q of db.questions) {
    db.byId.set(q.id, q);
  }

  const leafSet = new Set();
  for (const lawNode of db.tree) {
    for (const chNode of lawNode.chapters) {
      if (chNode.sections && chNode.sections.length > 0) {
        for (const secNode of chNode.sections) {
          leafSet.add(secNode.scopeKey);
        }
      } else {
        leafSet.add(chNode.scopeKey);
      }
    }
  }
  db.allLeafScopes = Array.from(leafSet);
}

/* =========================================================
 * 범위(법률 > 장 > 절) 필터링 및 비복원 랜덤 추출
 * ========================================================= */
function getActiveScopeSet() {
  if (!appState.selectedScopes || !Array.isArray(appState.selectedScopes)) {
    return new Set(db.allLeafScopes);
  }
  return new Set(appState.selectedScopes);
}

function getScopeQuestions(scopeSet = getActiveScopeSet()) {
  return db.questions.filter((q) => scopeSet.has(q.scopeKey));
}

function getUnseenScopeQuestions(scopeSet = getActiveScopeSet()) {
  const seenSet = new Set(appState.seenIds);
  return db.questions.filter((q) => scopeSet.has(q.scopeKey) && !seenSet.has(q.id));
}

function pickRandomCount(mode) {
  if (mode === '5') return 5;
  if (mode === '6') return 6;
  return Math.random() < 0.5 ? 5 : 6;
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * 새로운 모의고사 5~6문항 비복원 추출
 * @param {boolean} markCurrentSeen 현재 진행 중인 시험지를 출제 완료(seenIds)로 기록할지 여부
 */
function drawNewExam(markCurrentSeen = false) {
  if (markCurrentSeen && appState.activeExam && appState.activeExam.questionIds.length > 0) {
    const { earned, total } = calculateExamScore(appState.activeExam);
    const seenSet = new Set(appState.seenIds);
    for (const qid of appState.activeExam.questionIds) {
      seenSet.add(qid);
    }
    appState.seenIds = Array.from(seenSet);
    appState.history.unshift({
      round: appState.activeExam.round,
      cycle: appState.cycle,
      completedAt: new Date().toISOString(),
      questionIds: [...appState.activeExam.questionIds],
      earnedPoints: earned,
      totalPoints: total,
    });
    if (appState.history.length > 200) {
      appState.history.length = 200;
    }
    appState.round += 1;
  }

  const scopeQuestions = getScopeQuestions();
  if (scopeQuestions.length === 0) {
    showToast('선택된 출제 범위에 문항이 없습니다. 출제 범위를 먼저 선택해 주세요.');
    openModal('modalScope');
    return;
  }

  let unseenPool = getUnseenScopeQuestions();

  // 선택 범위의 모든 문항을 다 순회한 경우
  if (unseenPool.length === 0) {
    const isFullBank = scopeQuestions.length === db.totalQuestions;
    const msg = isFullBank
      ? `🎉 축하합니다! 전체 ${db.totalQuestions}문항(${appState.cycle}회독)을 빠짐없이 모두 순회했습니다.\n\n출제 기록을 초기화하고 ${appState.cycle + 1}회독을 새로 시작할까요?`
      : `🎉 현재 선택한 범위(${scopeQuestions.length}문항)의 모든 문제를 빠짐없이 순회했습니다!\n\n선택 범위의 문항들을 다시 미출제 상태로 초기화하고 새로 출제할까요?`;

    if (confirm(msg)) {
      const scopeIds = new Set(scopeQuestions.map((q) => q.id));
      appState.seenIds = appState.seenIds.filter((id) => !scopeIds.has(id));
      if (isFullBank) {
        appState.cycle += 1;
      }
      unseenPool = getUnseenScopeQuestions();
      showToast('순회 목록이 초기화되어 새로운 회독을 시작합니다.');
    } else {
      renderAll();
      saveState();
      return;
    }
  }

  const targetCount = pickRandomCount(appState.countMode);
  const picked = shuffleArray(unseenPool).slice(0, Math.min(targetCount, unseenPool.length));

  appState.activeExam = {
    round: appState.round,
    createdAt: new Date().toISOString(),
    questionIds: picked.map((q) => q.id),
    drafts: {},
    checkedRubrics: {},
    openAnswers: {},
  };

  resetTimer();
  saveState();
  renderAll();
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (picked.length < targetCount) {
    showToast(`남은 미출제 문항 ${picked.length}개를 모두 출제했습니다 (이번 범위 마지막 회차).`);
  } else {
    showToast(`제${appState.activeExam.round}회 모의고사 (${picked.length}문항)가 출제되었습니다.`);
  }
}

/* =========================================================
 * 렌더링
 * ========================================================= */
function renderAll() {
  renderProgressAndScopeBar();
  renderExamToolbar();
  renderExamQuestions();
  renderSyncStatusUI();
}

function renderProgressAndScopeBar() {
  const activeScopes = getActiveScopeSet();
  const scopeQuestions = getScopeQuestions(activeScopes);
  const seenSet = new Set(appState.seenIds);

  const scopeSeenCount = scopeQuestions.filter((q) => seenSet.has(q.id)).length;
  const scopeUnseenCount = scopeQuestions.length - scopeSeenCount;
  const scopePct = scopeQuestions.length > 0 ? ((scopeSeenCount / scopeQuestions.length) * 100).toFixed(1) : '0.0';

  document.getElementById('cycleBadge').textContent = `${appState.cycle}회독`;
  document.getElementById('scopeProgressText').textContent =
    `${scopeSeenCount} / ${scopeQuestions.length}문항 완료 (${scopePct}% · 미출제 ${scopeUnseenCount})`;
  document.getElementById('scopeProgressBar').style.width = `${scopePct}%`;

  // 현재 범위 요약 문구
  const isAllSelected = activeScopes.size === db.allLeafScopes.length;
  const summaryEl = document.getElementById('activeScopeSummary');
  const badgeEl = document.getElementById('scopeFilterBadge');
  if (isAllSelected) {
    summaryEl.textContent = `현재 범위: 4개 법률 전체 (모든 장·절 통합, ${db.totalQuestions}문항)`;
    badgeEl.textContent = `전체 ${db.totalQuestions}`;
  } else {
    const selectedLabels = describeSelectedScopes(activeScopes);
    summaryEl.textContent = `현재 범위: ${selectedLabels} (총 ${scopeQuestions.length}문항)`;
    badgeEl.textContent = `선택 ${scopeQuestions.length}문항`;
  }

  // 전체 418문항 누적 진행률
  const totalSeen = appState.seenIds.filter((id) => db.byId.has(id)).length;
  const totalPct = db.totalQuestions > 0 ? ((totalSeen / db.totalQuestions) * 100).toFixed(1) : '0.0';
  document.getElementById('totalProgressText').textContent = `${totalSeen} / ${db.totalQuestions}문항 (${totalPct}%)`;
  document.getElementById('totalProgressBar').style.width = `${totalPct}%`;

  const avgPerRound = appState.countMode === '5' ? 5 : appState.countMode === '6' ? 6 : 5.5;
  const estRounds = Math.ceil(scopeUnseenCount / avgPerRound);
  document.getElementById('remainingRoundsText').textContent =
    scopeUnseenCount > 0
      ? `선택 범위 완주까지 약 ${estRounds}회 남음 (미출제 ${scopeUnseenCount}문항)`
      : `선택 범위의 모든 문항을 순회 완료했습니다!`;

  const selectEl = document.getElementById('selectCountMode');
  if (selectEl.value !== appState.countMode) {
    selectEl.value = appState.countMode;
  }
}

function describeSelectedScopes(activeScopes) {
  const parts = [];
  for (const lawNode of db.tree) {
    const lawLeafs = [];
    for (const ch of lawNode.chapters) {
      if (ch.sections && ch.sections.length > 0) {
        for (const s of ch.sections) lawLeafs.push(s.scopeKey);
      } else {
        lawLeafs.push(ch.scopeKey);
      }
    }
    const matched = lawLeafs.filter((k) => activeScopes.has(k));
    if (matched.length === lawLeafs.length) {
      parts.push(`${lawNode.lawShort} 전체`);
    } else if (matched.length > 0) {
      parts.push(`${lawNode.lawShort}(${matched.length}개 영역)`);
    }
  }
  return parts.join(', ') || '선택 없음';
}

function calculateExamScore(exam) {
  if (!exam || !exam.questionIds) return { earned: 0, total: 0 };
  let earned = 0;
  let total = 0;
  const checked = exam.checkedRubrics || {};

  for (const qid of exam.questionIds) {
    const q = db.byId.get(qid);
    if (!q) continue;
    total += q.points;
    for (const part of q.parts) {
      (part.rubric || []).forEach((r, idx) => {
        const key = `${qid}_${part.number}_${idx}`;
        if (checked[key]) {
          earned += Number(r.points) || 0;
        }
      });
    }
  }
  return { earned, total };
}

function renderExamToolbar() {
  const toolbar = document.getElementById('examToolbar');
  const bottomBar = document.getElementById('examBottomBar');
  const exam = appState.activeExam;

  if (!exam || !exam.questionIds || exam.questionIds.length === 0) {
    toolbar.classList.add('hidden');
    bottomBar.classList.add('hidden');
    return;
  }

  toolbar.classList.remove('hidden');
  bottomBar.classList.remove('hidden');

  const qs = exam.questionIds.map((id) => db.byId.get(id)).filter(Boolean);
  const partCount = qs.reduce((acc, q) => acc + q.parts.length, 0);
  const { earned, total } = calculateExamScore(exam);
  const scorePct = total > 0 ? Math.round((earned / total) * 100) : 0;

  document.getElementById('examRoundBadge').textContent = `제${exam.round}회 모의고사`;
  document.getElementById('examMetaText').textContent =
    `대문항 ${qs.length}개 · 소문항 ${partCount}개 · 총 ${total}점`;
  document.getElementById('examScoreText').textContent = `${earned} / ${total}점 (${scorePct}%)`;
  document.getElementById('bottomSummaryText').textContent =
    `제${exam.round}회 모의고사 (${qs.length}문항 · 자가채점 ${earned}/${total}점) 학습을 마치셨나요?`;

  // 전체 펼치기/접기 버튼 라벨
  const allOpen = isAllAnswersOpen(exam, qs);
  document.getElementById('btnToggleAllAnswers').textContent = allOpen
    ? '🙈 모범답안 전체 접기'
    : '👁️ 모범답안 전체 펼치기';

  // 빠른 이동 탭
  const navContainer = document.getElementById('questionNavTabs');
  navContainer.innerHTML = qs
    .map((q, idx) => {
      const hasActivity = q.parts.some((p) => {
        const draftKey = `${q.id}_${p.number}`;
        const hasDraft = (exam.drafts?.[draftKey] || '').trim().length > 0;
        const hasCheck = (p.rubric || []).some((_, rIdx) => exam.checkedRubrics?.[`${q.id}_${p.number}_${rIdx}`]);
        return hasDraft || hasCheck;
      });
      return `
        <button type="button" class="q-nav-btn" data-scroll-target="q-card-${idx + 1}">
          ${hasActivity ? '<span class="done-dot"></span>' : ''}
          제${idx + 1}문 (${q.lawShort})
        </button>
      `;
    })
    .join('');
}

function isAllAnswersOpen(exam, qs) {
  if (!exam || !qs.length) return false;
  for (const q of qs) {
    for (const p of q.parts) {
      if (!exam.openAnswers?.[`${q.id}_${p.number}`]) return false;
    }
  }
  return true;
}

function renderExamQuestions() {
  const container = document.getElementById('examContainer');
  const exam = appState.activeExam;

  if (!exam || !exam.questionIds || exam.questionIds.length === 0) {
    container.innerHTML = `
      <div class="card question-card">
        <p>현재 출제된 모의고사가 없습니다. 상단의 <strong>새 모의고사 출제</strong> 버튼을 눌러 주세요.</p>
      </div>
    `;
    return;
  }

  const qs = exam.questionIds.map((id) => db.byId.get(id)).filter(Boolean);

  container.innerHTML = qs
    .map((q, qIdx) => {
      const subRegulations = [];
      if (q.decree) {
        subRegulations.push(`${q.decree.name} (${(q.decree.articles || []).join(', ')})`);
      }
      if (q.rule) {
        subRegulations.push(`${q.rule.name} (${(q.rule.articles || []).join(', ')})`);
      }
      if (q.notices && q.notices.length > 0) {
        for (const n of q.notices) {
          subRegulations.push(`${n.name} (${(n.articles || []).join(', ')})`);
        }
      }

      const partsHtml = q.parts
        .map((part) => {
          const partKey = `${q.id}_${part.number}`;
          const draftVal = exam.drafts?.[partKey] || '';
          const isOpen = Boolean(exam.openAnswers?.[partKey]);

          let partEarned = 0;
          const rubricHtml = (part.rubric || [])
            .map((r, rIdx) => {
              const rKey = `${q.id}_${part.number}_${rIdx}`;
              const isChecked = Boolean(exam.checkedRubrics?.[rKey]);
              if (isChecked) partEarned += Number(r.points) || 0;
              return `
                <label class="rubric-item-label ${isChecked ? 'checked' : ''}">
                  <div class="rubric-left">
                    <input
                      type="checkbox"
                      class="rubric-checkbox"
                      data-rubric-key="${rKey}"
                      ${isChecked ? 'checked' : ''}
                    />
                    <span>${escapeHtml(r.item)}</span>
                  </div>
                  <span class="rubric-pts">+${r.points}점</span>
                </label>
              `;
            })
            .join('');

          return `
            <div class="part-item" id="part-${partKey}">
              <div class="part-question-row">
                <div class="part-question-text">
                  <span class="part-num">${part.number})</span>
                  ${escapeHtml(part.question)}
                </div>
                <span class="part-points-tag">${part.points}점</span>
              </div>

              <div class="draft-box">
                <textarea
                  class="draft-textarea"
                  placeholder="여기에 서술형 답안 초안이나 핵심 키워드를 메모해 보세요 (자동 저장)..."
                  data-draft-key="${partKey}"
                >${escapeHtml(draftVal)}</textarea>
                <div class="part-action-bar">
                  <span class="draft-char-count" id="char-count-${partKey}">
                    작성 글자 수: ${draftVal.length}자
                  </span>
                  <div style="display:flex; gap:8px; align-items:center;">
                    <span class="badge badge-points" id="part-score-${partKey}">
                      채점: ${partEarned} / ${part.points}점
                    </span>
                    <button
                      type="button"
                      class="btn btn-sm ${isOpen ? 'btn-primary' : 'btn-outline'}"
                      data-toggle-answer="${partKey}"
                    >
                      ${isOpen ? '🙈 모범답안·채점기준 접기' : '💡 모범답안·채점기준 보기'}
                    </button>
                  </div>
                </div>
              </div>

              <div class="answer-panel ${isOpen ? '' : 'hidden'}" id="answer-panel-${partKey}">
                <div class="model-answer-box">
                  <div class="panel-section-label">
                    <span>📖 모범답안</span>
                    <span>배점 ${part.points}점</span>
                  </div>
                  <div class="model-answer-content">${formatAnswerHtml(part.answer)}</div>
                </div>

                <div class="rubric-box">
                  <div class="rubric-header">
                    <span class="rubric-title">✅ 채점 기준 (체크하여 자가채점)</span>
                    <button
                      type="button"
                      class="btn btn-xs btn-ghost"
                      data-check-all-part="${partKey}"
                      data-part-rubric-len="${(part.rubric || []).length}"
                    >
                      전체 선택/해제
                    </button>
                  </div>
                  <div class="rubric-list">
                    ${rubricHtml}
                  </div>
                </div>

                <div class="basis-meta-row">
                  <span>📌 <strong>출제 근거:</strong> ${escapeHtml(part.basis)}</span>
                </div>
              </div>
            </div>
          `;
        })
        .join('');

      return `
        <article class="card question-card" id="q-card-${qIdx + 1}">
          <div class="q-card-header">
            <div class="q-header-top">
              <div class="q-badges">
                <span class="q-num-badge">제${qIdx + 1}문</span>
                <span class="q-id-code">${escapeHtml(q.id)}</span>
                <span class="badge badge-law">${escapeHtml(q.lawShort)}</span>
                <span class="badge badge-chapter">${escapeHtml(q.chapter)}</span>
                <span class="badge badge-effective">${escapeHtml(q.effective)} 시행본</span>
              </div>
              <span class="badge badge-points">총 ${q.points}점</span>
            </div>

            <div class="q-title-row">
              <h2 class="q-title">${escapeHtml(q.title)}</h2>
              <span class="q-articles-meta">
                관련 조문: ${escapeHtml((q.articles || []).join(', '))}
                ${subRegulations.length ? ` · ${escapeHtml(subRegulations.join(' / '))}` : ''}
              </span>
            </div>
          </div>

          <div class="q-stem-box">
            ${escapeHtml(q.stem)}
          </div>

          <div class="parts-list">
            ${partsHtml}
          </div>

          ${
            q.note
              ? `<div class="q-note-box">💡 <strong>출제·답안 참고사항:</strong> ${escapeHtml(q.note)}</div>`
              : ''
          }
        </article>
      `;
    })
    .join('');
}

function formatAnswerHtml(text) {
  if (!text) return '';
  const escaped = escapeHtml(text);
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* =========================================================
 * 출제 범위 설정 모달 (법률 > 장 > 절 3단계 트리)
 * ========================================================= */
function openScopeModal() {
  tempSelectedScopes = new Set(getActiveScopeSet());
  renderScopeTreeModal();
  openModal('modalScope');
}

function renderScopeTreeModal() {
  const container = document.getElementById('scopeTreeContainer');
  const seenSet = new Set(appState.seenIds);

  // 선택된 문항 및 미출제 문항 집계
  const selectedQuestions = getScopeQuestions(tempSelectedScopes);
  const unseenSelected = selectedQuestions.filter((q) => !seenSet.has(q.id)).length;
  document.getElementById('modalScopeSelectionStats').textContent =
    `선택된 문항: ${selectedQuestions.length}개 (미출제 ${unseenSelected}개 / 완료 ${selectedQuestions.length - unseenSelected}개)`;

  container.innerHTML = db.tree
    .map((lawNode, lawIdx) => {
      const lawQuestions = db.questions.filter((q) => q.law === lawNode.law);
      const lawUnseen = lawQuestions.filter((q) => !seenSet.has(q.id)).length;

      const chaptersHtml = lawNode.chapters
        .map((chNode, chIdx) => {
          const chQuestions = db.questions.filter(
            (q) => q.law === lawNode.law && q.chapterGroup === chNode.chapterGroup
          );
          const chUnseen = chQuestions.filter((q) => !seenSet.has(q.id)).length;

          if (chNode.sections && chNode.sections.length > 0) {
            const secsHtml = chNode.sections
              .map((secNode) => {
                const secQuestions = db.questions.filter((q) => q.scopeKey === secNode.scopeKey);
                const secUnseen = secQuestions.filter((q) => !seenSet.has(q.id)).length;
                const isChecked = tempSelectedScopes.has(secNode.scopeKey);
                return `
                  <div class="section-row">
                    <label class="tree-check-label">
                      <input
                        type="checkbox"
                        class="scope-sec-chk"
                        data-scope-key="${escapeHtml(secNode.scopeKey)}"
                        data-law-idx="${lawIdx}"
                        data-ch-idx="${chIdx}"
                        ${isChecked ? 'checked' : ''}
                      />
                      <span>${escapeHtml(secNode.section)}</span>
                    </label>
                    <span class="count-pill">미출제 <strong>${secUnseen}</strong> / ${secNode.count}</span>
                  </div>
                `;
              })
              .join('');

            return `
              <div class="chapter-node">
                <div class="chapter-row">
                  <label class="tree-check-label">
                    <input
                      type="checkbox"
                      class="scope-ch-parent-chk"
                      data-law-idx="${lawIdx}"
                      data-ch-idx="${chIdx}"
                    />
                    <span>${escapeHtml(chNode.chapterGroup)}</span>
                  </label>
                  <span class="count-pill">미출제 <strong>${chUnseen}</strong> / ${chNode.count}</span>
                </div>
                <div class="section-list">
                  ${secsHtml}
                </div>
              </div>
            `;
          } else {
            const isChecked = tempSelectedScopes.has(chNode.scopeKey);
            return `
              <div class="chapter-node">
                <div class="chapter-row">
                  <label class="tree-check-label">
                    <input
                      type="checkbox"
                      class="scope-ch-leaf-chk"
                      data-scope-key="${escapeHtml(chNode.scopeKey)}"
                      data-law-idx="${lawIdx}"
                      data-ch-idx="${chIdx}"
                      ${isChecked ? 'checked' : ''}
                    />
                    <span>${escapeHtml(chNode.chapterGroup)}</span>
                  </label>
                  <span class="count-pill">미출제 <strong>${chUnseen}</strong> / ${chNode.count}</span>
                </div>
              </div>
            `;
          }
        })
        .join('');

      return `
        <div class="law-group-card">
          <div class="law-group-header">
            <label class="tree-check-label">
              <input type="checkbox" class="scope-law-chk" data-law-idx="${lawIdx}" />
              <span>${escapeHtml(lawNode.law)}</span>
            </label>
            <span class="count-pill">미출제 <strong>${lawUnseen}</strong> / ${lawNode.count}문항</span>
          </div>
          <div class="chapter-list">
            ${chaptersHtml}
          </div>
        </div>
      `;
    })
    .join('');

  updateScopeTreeParentStates();
}

function updateScopeTreeParentStates() {
  // 절이 있는 장의 부모 체크박스 상태(checked / indeterminate) 갱신
  document.querySelectorAll('.scope-ch-parent-chk').forEach((chChk) => {
    const lawIdx = Number(chChk.dataset.lawIdx);
    const chIdx = Number(chChk.dataset.chIdx);
    const chNode = db.tree[lawIdx].chapters[chIdx];
    const keys = chNode.sections.map((s) => s.scopeKey);
    const checkedCount = keys.filter((k) => tempSelectedScopes.has(k)).length;
    chChk.checked = checkedCount === keys.length && keys.length > 0;
    chChk.indeterminate = checkedCount > 0 && checkedCount < keys.length;
  });

  // 법률 단위 체크박스 상태(checked / indeterminate) 갱신
  document.querySelectorAll('.scope-law-chk').forEach((lawChk) => {
    const lawIdx = Number(lawChk.dataset.lawIdx);
    const lawNode = db.tree[lawIdx];
    const keys = [];
    for (const ch of lawNode.chapters) {
      if (ch.sections && ch.sections.length > 0) {
        for (const s of ch.sections) keys.push(s.scopeKey);
      } else {
        keys.push(ch.scopeKey);
      }
    }
    const checkedCount = keys.filter((k) => tempSelectedScopes.has(k)).length;
    lawChk.checked = checkedCount === keys.length && keys.length > 0;
    lawChk.indeterminate = checkedCount > 0 && checkedCount < keys.length;
  });

  const seenSet = new Set(appState.seenIds);
  const selectedQuestions = getScopeQuestions(tempSelectedScopes);
  const unseenSelected = selectedQuestions.filter((q) => !seenSet.has(q.id)).length;
  document.getElementById('modalScopeSelectionStats').textContent =
    `선택된 문항: ${selectedQuestions.length}개 (미출제 ${unseenSelected}개 / 완료 ${selectedQuestions.length - unseenSelected}개)`;
}

/* =========================================================
 * 순회 이력 모달
 * ========================================================= */
function openHistoryModal() {
  renderHistoryModal();
  openModal('modalHistory');
}

function renderHistoryModal() {
  const seenSet = new Set(appState.seenIds);
  const activeScopes = getActiveScopeSet();
  const scopeQs = getScopeQuestions(activeScopes);
  const scopeSeen = scopeQs.filter((q) => seenSet.has(q.id));
  const scopeUnseen = scopeQs.filter((q) => !seenSet.has(q.id));

  document.getElementById('historySummaryStats').innerHTML = `
    <strong>전체 완료:</strong> ${appState.seenIds.length} / ${db.totalQuestions}문항 ·
    <strong>선택 범위 완료:</strong> ${scopeSeen.length} / ${scopeQs.length}문항 (미출제 ${scopeUnseen.length}문항)
  `;

  document.querySelectorAll('[data-history-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.historyTab === activeHistoryTab);
  });

  const content = document.getElementById('historyTabContent');
  if (activeHistoryTab === 'rounds') {
    if (!appState.history || appState.history.length === 0) {
      content.innerHTML = `<p class="help-text">아직 완료 처리한 모의고사 회차 기록이 없습니다.</p>`;
      return;
    }
    content.innerHTML = `
      <div class="history-list">
        ${appState.history
          .map((h) => {
            const dateStr = new Date(h.completedAt).toLocaleString('ko-KR');
            return `
              <div class="history-item">
                <div>
                  <strong>${h.cycle || 1}회독 · 제${h.round}회 모의고사</strong>
                  <span class="help-text" style="margin-left:8px;">${escapeHtml(dateStr)}</span>
                  <div class="help-text" style="margin-top:4px;">
                    출제 문항(${h.questionIds.length}개): ${escapeHtml(h.questionIds.join(', '))}
                  </div>
                </div>
                <div style="display:flex; gap:8px; align-items:center;">
                  <span class="badge badge-points">채점 ${h.earnedPoints} / ${h.totalPoints}점</span>
                  <button type="button" class="btn btn-xs btn-outline" data-load-history-round="${h.round}">
                    다시 열기
                  </button>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  } else if (activeHistoryTab === 'seen') {
    const seenQuestions = db.questions.filter((q) => seenSet.has(q.id));
    if (seenQuestions.length === 0) {
      content.innerHTML = `<p class="help-text">현재 회독에서 출제 완료된 문항이 없습니다.</p>`;
      return;
    }
    content.innerHTML = `
      <div class="history-list">
        ${seenQuestions
          .map(
            (q) => `
            <div class="history-item">
              <div>
                <span class="q-id-code">${escapeHtml(q.id)}</span>
                <strong style="margin-left:6px;">${escapeHtml(q.title)}</strong>
                <div class="help-text">${escapeHtml(q.lawShort)} · ${escapeHtml(q.chapter)}</div>
              </div>
              <button type="button" class="btn btn-xs btn-outline" data-unmark-seen="${escapeHtml(q.id)}">
                ↩ 미출제로 되돌리기
              </button>
            </div>
          `
          )
          .join('')}
      </div>
    `;
  } else {
    if (scopeUnseen.length === 0) {
      content.innerHTML = `<p class="help-text">선택 범위의 모든 문항이 순회 완료되었습니다!</p>`;
      return;
    }
    content.innerHTML = `
      <div class="history-list">
        ${scopeUnseen
          .slice(0, 150)
          .map(
            (q) => `
            <div class="history-item">
              <div>
                <span class="q-id-code">${escapeHtml(q.id)}</span>
                <strong style="margin-left:6px;">${escapeHtml(q.title)}</strong>
                <div class="help-text">${escapeHtml(q.lawShort)} · ${escapeHtml(q.chapter)}</div>
              </div>
              <span class="badge badge-dark">${q.points}점</span>
            </div>
          `
          )
          .join('')}
        ${
          scopeUnseen.length > 150
            ? `<p class="help-text" style="text-align:center; padding:8px;">외 ${scopeUnseen.length - 150}개 문항 대기 중...</p>`
            : ''
        }
      </div>
    `;
  }
}

/* =========================================================
 * 로컬 저장소 및 GitHub Secret Gist 클라우드 동기화
 * ========================================================= */
function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      appState = {
        ...appState,
        ...parsed,
      };
    }
  } catch (e) {
    console.warn('로컬 상태 로드 실패:', e);
  }
}

function saveState(skipCloud = false) {
  appState.updatedAt = Date.now();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
  } catch (e) {
    console.warn('로컬 상태 저장 실패:', e);
  }
  if (!skipCloud && syncConfig && syncConfig.gistId && syncConfig.token) {
    schedulePushToCloud();
  }
}

function checkUrlSyncPairing() {
  const hash = window.location.hash || '';
  if (!hash.startsWith('#sync=')) return;
  try {
    const encoded = hash.slice('#sync='.length);
    const jsonStr = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const cfg = JSON.parse(jsonStr);
    if (cfg && cfg.gistId && cfg.token) {
      localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(cfg));
      // 주소창에서 토큰 해시 즉시 제거
      history.replaceState(null, '', window.location.pathname + window.location.search);
      setTimeout(() => {
        showToast('📱 스마트폰 클라우드 연동이 자동으로 완료되었습니다!');
      }, 300);
    }
  } catch (e) {
    console.error('URL 연동 파싱 실패:', e);
  }
}

function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_CONFIG_KEY);
    if (raw) {
      syncConfig = JSON.parse(raw);
    }
  } catch (e) {
    syncConfig = null;
  }
}

function getPairingUrl() {
  if (!syncConfig || !syncConfig.gistId || !syncConfig.token) return '';
  const payload = JSON.stringify({ gistId: syncConfig.gistId, token: syncConfig.token });
  const b64 = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const baseUrl = window.location.origin + window.location.pathname;
  return `${baseUrl}#sync=${b64}`;
}

function makeQrDataUrl(text) {
  if (typeof qrcode !== 'function') return '';
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(4, 8);
}

function renderSyncStatusUI() {
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  const banner = document.getElementById('syncStatusBanner');
  const qrSection = document.getElementById('qrPairSection');
  const inputGist = document.getElementById('inputGistId');
  const inputToken = document.getElementById('inputGithubToken');

  if (syncConfig && syncConfig.gistId && syncConfig.token) {
    dot.className = isSyncing ? 'sync-dot syncing' : 'sync-dot online';
    label.textContent = isSyncing ? '동기화 중...' : '연동됨';
    if (banner) {
      banner.innerHTML = `
        <strong style="color:var(--success);">✅ 클라우드 실시간 동기화 활성화됨</strong><br/>
        <span class="help-text">Gist ID: <code>${escapeHtml(syncConfig.gistId)}</code> · PC와 스마트폰에서 진행 상태가 자동으로 동기화됩니다.</span>
      `;
    }
    if (qrSection) {
      qrSection.classList.remove('hidden');
      const pairUrl = getPairingUrl();
      const qrImg = document.getElementById('qrCodeImg');
      if (qrImg && pairUrl) {
        // 연동 링크에는 토큰이 들어 있으므로 외부 QR 서비스로 보내지 않고 기기 안에서 그린다.
        qrImg.src = makeQrDataUrl(pairUrl);
      }
    }
    if (inputGist && !inputGist.value) inputGist.value = syncConfig.gistId;
    if (inputToken && !inputToken.value) inputToken.value = syncConfig.token;
  } else {
    dot.className = 'sync-dot offline';
    label.textContent = '기기 연동';
    if (banner) {
      banner.innerHTML = `
        <strong>ℹ️ 현재 기기 단독 저장 모드 (브라우저 로컬 저장)</strong><br/>
        <span class="help-text">아래 설정에서 Gist ID와 토큰을 등록하거나, PC에서 생성한 연동 QR/링크를 열면 PC와 폰이 실시간 연동됩니다.</span>
      `;
    }
    if (qrSection) {
      qrSection.classList.add('hidden');
    }
  }
}

function schedulePushToCloud() {
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => {
    pushToCloud();
  }, 650);
}

async function pushToCloud() {
  if (!syncConfig || !syncConfig.gistId || !syncConfig.token) return;
  isSyncing = true;
  renderSyncStatusUI();
  try {
    const res = await fetch(`https://api.github.com/gists/${syncConfig.gistId}`, {
      method: 'PATCH',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${syncConfig.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: {
          [GIST_FILENAME]: {
            content: JSON.stringify(appState),
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`Gist 저장 실패 (${res.status})`);
  } catch (e) {
    console.warn('클라우드 동기화 푸시 오류:', e);
  } finally {
    isSyncing = false;
    renderSyncStatusUI();
  }
}

async function pullFromCloud(silent = false) {
  if (!syncConfig || !syncConfig.gistId || !syncConfig.token) return false;
  isSyncing = true;
  renderSyncStatusUI();
  try {
    const res = await fetch(`https://api.github.com/gists/${syncConfig.gistId}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${syncConfig.token}`,
      },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Gist 조회 실패 (${res.status})`);
    const gist = await res.json();
    const fileObj = gist.files && gist.files[GIST_FILENAME];
    if (fileObj && fileObj.content) {
      const remoteState = JSON.parse(fileObj.content);
      if (remoteState && typeof remoteState === 'object') {
        const remoteTime = Number(remoteState.updatedAt) || 0;
        const localTime = Number(appState.updatedAt) || 0;

        // 원격 상태가 더 최신이거나 로컬에 아직 진행 상태가 없을 때 원격 상태 반영
        if (remoteTime > localTime || (!appState.activeExam && remoteState.activeExam)) {
          appState = {
            ...appState,
            ...remoteState,
          };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
          renderAll();
          if (!silent) showToast('☁️ 클라우드에서 최신 진행 상태를 불러왔습니다.');
        } else if (localTime > remoteTime) {
          await pushToCloud();
          if (!silent) showToast('☁️ 현재 기기의 최신 상태를 클라우드에 반영했습니다.');
        } else if (!silent) {
          showToast('☁️ 이미 최신 상태로 동기화되어 있습니다.');
        }
      }
    } else {
      await pushToCloud();
    }
    return true;
  } catch (e) {
    console.warn('클라우드 동기화 풀 오류:', e);
    if (!silent) showToast(`⚠️ 동기화 실패: ${e.message}`);
    return false;
  } finally {
    isSyncing = false;
    renderSyncStatusUI();
  }
}

/* =========================================================
 * PWA 서비스 워커 및 설치 프롬프트, 테마, 타이머
 * ========================================================= */
function initPwa() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('Service Worker 등록 실패:', err);
      });
    });
  }

  const installBtn = document.getElementById('btnInstallPwa');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installBtn) installBtn.classList.remove('hidden');
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') {
        installBtn.classList.add('hidden');
      }
      deferredInstallPrompt = null;
    });
  }

  window.addEventListener('appinstalled', () => {
    if (installBtn) installBtn.classList.add('hidden');
    deferredInstallPrompt = null;
    showToast('📲 모의고사 앱이 기기에 설치되었습니다!');
  });
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  setTheme(theme);
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
  const btn = document.getElementById('btnThemeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function toggleTimer() {
  const btn = document.getElementById('btnTimerToggle');
  if (timerRunning) {
    clearInterval(timerInterval);
    timerRunning = false;
    btn.textContent = '▶ 계속';
  } else {
    timerRunning = true;
    btn.textContent = '⏸ 일시정지';
    timerInterval = setInterval(() => {
      timerSeconds += 1;
      updateTimerDisplay();
    }, 1000);
  }
}

function resetTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerRunning = false;
  timerSeconds = 0;
  updateTimerDisplay();
  const btn = document.getElementById('btnTimerToggle');
  if (btn) btn.textContent = '▶ 시작';
}

function updateTimerDisplay() {
  const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
  const s = String(timerSeconds % 60).padStart(2, '0');
  const el = document.getElementById('timerDisplay');
  if (el) el.textContent = `${m}:${s}`;
}

/* =========================================================
 * 모달 및 토스트 유틸리티
 * ========================================================= */
function openModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('hidden');
    el.setAttribute('aria-hidden', 'true');
  }
}

function showToast(msg) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const item = document.createElement('div');
  item.className = 'toast';
  item.textContent = msg;
  container.appendChild(item);
  setTimeout(() => {
    item.remove();
  }, 3200);
}

/* =========================================================
 * 이벤트 바인딩
 * ========================================================= */
function bindEvents() {
  // 테마 전환
  document.getElementById('btnThemeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    setTheme(cur);
  });

  // 회당 문항 수 변경
  document.getElementById('selectCountMode').addEventListener('change', (e) => {
    appState.countMode = e.target.value;
    saveState();
    renderProgressAndScopeBar();
    showToast(`회당 출제 문항 수가 변경되었습니다. 다음 모의고사부터 적용됩니다.`);
  });

  // 이번 회차 완료 & 다음 모의고사 출제 (상단/하단 버튼)
  document.getElementById('btnCompleteAndNext').addEventListener('click', () => {
    drawNewExam(true);
  });
  document.getElementById('btnCompleteBottom').addEventListener('click', () => {
    drawNewExam(true);
  });

  // 현재 시험지 미출제 유지 재추출
  document.getElementById('btnRedrawExam').addEventListener('click', () => {
    drawNewExam(false);
  });

  // 맨 위로 이동
  document.getElementById('btnScrollTop').addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // 타이머
  document.getElementById('btnTimerToggle').addEventListener('click', toggleTimer);
  document.getElementById('btnTimerReset').addEventListener('click', resetTimer);

  // 전체 모범답안 펼치기/접기
  document.getElementById('btnToggleAllAnswers').addEventListener('click', () => {
    const exam = appState.activeExam;
    if (!exam) return;
    const qs = exam.questionIds.map((id) => db.byId.get(id)).filter(Boolean);
    const nextState = !isAllAnswersOpen(exam, qs);
    exam.openAnswers = exam.openAnswers || {};
    for (const q of qs) {
      for (const p of q.parts) {
        exam.openAnswers[`${q.id}_${p.number}`] = nextState;
      }
    }
    saveState();
    renderExamToolbar();
    renderExamQuestions();
  });

  // 문항 빠른 이동 탭 클릭
  document.getElementById('questionNavTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-scroll-target]');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.scrollTarget);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  // 시험지 영역 내부 이벤트 위임 (답안 토글, 루브릭 체크, 답안 입력)
  const examContainer = document.getElementById('examContainer');

  examContainer.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('[data-toggle-answer]');
    if (toggleBtn) {
      const partKey = toggleBtn.dataset.toggleAnswer;
      const exam = appState.activeExam;
      if (!exam) return;
      exam.openAnswers = exam.openAnswers || {};
      exam.openAnswers[partKey] = !exam.openAnswers[partKey];
      const panel = document.getElementById(`answer-panel-${partKey}`);
      if (panel) panel.classList.toggle('hidden', !exam.openAnswers[partKey]);
      toggleBtn.className = `btn btn-sm ${exam.openAnswers[partKey] ? 'btn-primary' : 'btn-outline'}`;
      toggleBtn.textContent = exam.openAnswers[partKey]
        ? '🙈 모범답안·채점기준 접기'
        : '💡 모범답안·채점기준 보기';
      renderExamToolbar();
      saveState();
      return;
    }

    const checkAllBtn = e.target.closest('[data-check-all-part]');
    if (checkAllBtn) {
      const partKey = checkAllBtn.dataset.checkAllPart;
      const len = Number(checkAllBtn.dataset.partRubricLen) || 0;
      const exam = appState.activeExam;
      if (!exam) return;
      exam.checkedRubrics = exam.checkedRubrics || {};
      let allChecked = true;
      for (let i = 0; i < len; i++) {
        if (!exam.checkedRubrics[`${partKey}_${i}`]) allChecked = false;
      }
      for (let i = 0; i < len; i++) {
        exam.checkedRubrics[`${partKey}_${i}`] = !allChecked;
      }
      saveState();
      renderExamToolbar();
      renderExamQuestions();
    }
  });

  examContainer.addEventListener('change', (e) => {
    if (e.target.classList.contains('rubric-checkbox')) {
      const rKey = e.target.dataset.rubricKey;
      const exam = appState.activeExam;
      if (!exam) return;
      exam.checkedRubrics = exam.checkedRubrics || {};
      exam.checkedRubrics[rKey] = e.target.checked;
      const label = e.target.closest('.rubric-item-label');
      if (label) label.classList.toggle('checked', e.target.checked);

      // 해당 소문항 점수 배지 업데이트
      const [qid, partNum] = rKey.split('_');
      const q = db.byId.get(qid);
      const part = q?.parts.find((p) => String(p.number) === String(partNum));
      if (part) {
        let partEarned = 0;
        (part.rubric || []).forEach((r, idx) => {
          if (exam.checkedRubrics[`${qid}_${partNum}_${idx}`]) {
            partEarned += Number(r.points) || 0;
          }
        });
        const badge = document.getElementById(`part-score-${qid}_${partNum}`);
        if (badge) badge.textContent = `채점: ${partEarned} / ${part.points}점`;
      }

      renderExamToolbar();
      saveState();
    }
  });

  examContainer.addEventListener('input', (e) => {
    if (e.target.classList.contains('draft-textarea')) {
      const partKey = e.target.dataset.draftKey;
      const exam = appState.activeExam;
      if (!exam) return;
      exam.drafts = exam.drafts || {};
      exam.drafts[partKey] = e.target.value;
      const charEl = document.getElementById(`char-count-${partKey}`);
      if (charEl) charEl.textContent = `작성 글자 수: ${e.target.value.length}자`;
      saveState();
    }
  });

  // 모달 열기/닫기
  document.getElementById('btnScopeModal').addEventListener('click', openScopeModal);
  document.getElementById('btnHistoryModal').addEventListener('click', openHistoryModal);
  document.getElementById('btnSyncModal').addEventListener('click', () => {
    renderSyncStatusUI();
    openModal('modalSync');
  });

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.classList.add('hidden');
    });
  });

  // 출제 범위 모달 내 빠른 선택 버튼
  document.querySelectorAll('[data-quick-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.quickScope;
      if (target === 'ALL') {
        tempSelectedScopes = new Set(db.allLeafScopes);
      } else if (target === 'NONE') {
        tempSelectedScopes.clear();
      } else {
        tempSelectedScopes = new Set(
          db.questions.filter((q) => q.law === target).map((q) => q.scopeKey)
        );
      }
      renderScopeTreeModal();
    });
  });

  // 출제 범위 트리 체크박스 변경
  document.getElementById('scopeTreeContainer').addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('scope-sec-chk') || t.classList.contains('scope-ch-leaf-chk')) {
      const key = t.dataset.scopeKey;
      if (t.checked) tempSelectedScopes.add(key);
      else tempSelectedScopes.delete(key);
      updateScopeTreeParentStates();
    } else if (t.classList.contains('scope-ch-parent-chk')) {
      const lawIdx = Number(t.dataset.lawIdx);
      const chIdx = Number(t.dataset.chIdx);
      const chNode = db.tree[lawIdx].chapters[chIdx];
      for (const s of chNode.sections) {
        if (t.checked) tempSelectedScopes.add(s.scopeKey);
        else tempSelectedScopes.delete(s.scopeKey);
      }
      renderScopeTreeModal();
    } else if (t.classList.contains('scope-law-chk')) {
      const lawIdx = Number(t.dataset.lawIdx);
      const lawNode = db.tree[lawIdx];
      for (const ch of lawNode.chapters) {
        if (ch.sections && ch.sections.length > 0) {
          for (const s of ch.sections) {
            if (t.checked) tempSelectedScopes.add(s.scopeKey);
            else tempSelectedScopes.delete(s.scopeKey);
          }
        } else {
          if (t.checked) tempSelectedScopes.add(ch.scopeKey);
          else tempSelectedScopes.delete(ch.scopeKey);
        }
      }
      renderScopeTreeModal();
    }
  });

  // 범위 적용 버튼
  document.getElementById('btnApplyScope').addEventListener('click', () => {
    if (tempSelectedScopes.size === 0) {
      showToast('최소 1개 이상의 장·절을 선택해 주세요.');
      return;
    }
    if (tempSelectedScopes.size === db.allLeafScopes.length) {
      appState.selectedScopes = null;
    } else {
      appState.selectedScopes = Array.from(tempSelectedScopes);
    }
    closeModal('modalScope');
    const redraw = document.getElementById('chkRedrawOnScopeApply').checked;
    if (redraw) {
      drawNewExam(false);
    } else {
      saveState();
      renderAll();
      showToast('출제 범위가 저장되었습니다. 다음 모의고사부터 적용됩니다.');
    }
  });

  // 순회 이력 모달 탭 및 기능
  document.querySelectorAll('[data-history-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeHistoryTab = btn.dataset.historyTab;
      renderHistoryModal();
    });
  });

  document.getElementById('historyTabContent').addEventListener('click', (e) => {
    const unmarkBtn = e.target.closest('[data-unmark-seen]');
    if (unmarkBtn) {
      const qid = unmarkBtn.dataset.unmarkSeen;
      appState.seenIds = appState.seenIds.filter((id) => id !== qid);
      saveState();
      renderHistoryModal();
      renderProgressAndScopeBar();
      showToast(`${qid} 문항을 미출제 상태로 되돌렸습니다.`);
      return;
    }

    const loadRoundBtn = e.target.closest('[data-load-history-round]');
    if (loadRoundBtn) {
      const rNum = Number(loadRoundBtn.dataset.loadHistoryRound);
      const record = appState.history.find((h) => h.round === rNum);
      if (record) {
        appState.activeExam = {
          round: record.round,
          createdAt: record.completedAt,
          questionIds: [...record.questionIds],
          drafts: {},
          checkedRubrics: {},
          openAnswers: {},
        };
        saveState();
        closeModal('modalHistory');
        renderAll();
        showToast(`제${record.round}회 모의고사 문항들을 다시 불러왔습니다.`);
      }
    }
  });

  document.getElementById('btnResetScopeSeen').addEventListener('click', () => {
    const scopeQs = getScopeQuestions();
    if (!confirm(`현재 선택된 범위(${scopeQs.length}문항)의 출제 완료 기록을 초기화할까요?`)) return;
    const scopeIds = new Set(scopeQs.map((q) => q.id));
    appState.seenIds = appState.seenIds.filter((id) => !scopeIds.has(id));
    saveState();
    renderHistoryModal();
    renderProgressAndScopeBar();
    showToast('선택 범위의 순회 기록이 초기화되었습니다.');
  });

  document.getElementById('btnResetAllSeen').addEventListener('click', () => {
    if (!confirm(`전체 ${db.totalQuestions}문항의 순회 기록과 회차 이력을 모두 초기화하고 처음(1회독)부터 다시 시작할까요?`)) return;
    appState.seenIds = [];
    appState.cycle = 1;
    appState.round = 1;
    appState.history = [];
    drawNewExam(false);
    renderHistoryModal();
    showToast('전체 순회 기록이 초기화되었습니다.');
  });

  // 백업 내보내기 / 불러오기
  document.getElementById('btnExportState').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(appState, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `정보보호관리_모의고사_진행상태_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('inputImportState').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!imported || !Array.isArray(imported.seenIds)) {
        throw new Error('올바른 진행 상태 백업 파일이 아닙니다.');
      }
      appState = { ...appState, ...imported };
      saveState();
      renderAll();
      renderHistoryModal();
      showToast('백업 파일에서 진행 상태를 성공적으로 복원했습니다.');
    } catch (err) {
      alert(`불러오기 실패: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  });

  // 클라우드 동기화 설정 저장 및 연동 링크 복사
  document.getElementById('btnSaveSyncConfig').addEventListener('click', async () => {
    const gistId = document.getElementById('inputGistId').value.trim();
    const token = document.getElementById('inputGithubToken').value.trim();
    if (!gistId || !token) {
      showToast('Gist ID와 토큰을 모두 입력해 주세요.');
      return;
    }
    syncConfig = { gistId, token };
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(syncConfig));
    const ok = await pullFromCloud(false);
    if (ok) {
      await pushToCloud();
      renderSyncStatusUI();
    }
  });

  document.getElementById('btnDisconnectSync').addEventListener('click', () => {
    if (!confirm('이 기기에서 클라우드 동기화 연동을 해제할까요?')) return;
    syncConfig = null;
    localStorage.removeItem(SYNC_CONFIG_KEY);
    document.getElementById('inputGistId').value = '';
    document.getElementById('inputGithubToken').value = '';
    renderSyncStatusUI();
    showToast('클라우드 연동이 해제되었습니다.');
  });

  document.getElementById('btnCopyPairLink').addEventListener('click', async () => {
    const url = getPairingUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast('🔗 스마트폰 연동 링크가 복사되었습니다! 카카오톡 나에게 보내기 등으로 폰에서 열어주세요.');
    } catch {
      prompt('아래 연동 링크를 복사하여 스마트폰 브라우저에서 열어주세요:', url);
    }
  });

  document.getElementById('btnForceSyncNow').addEventListener('click', async () => {
    await pullFromCloud(false);
  });

  // 화면 포커스 복귀 시 원격 상태 자동 확인 (PC ↔ 폰 전환 시 즉시 반영)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && syncConfig && syncConfig.gistId && syncConfig.token) {
      pullFromCloud(true);
    }
  });
}
