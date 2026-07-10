const state = {
  payload: null,
  games: [],
  index: [],
  facets: {},
  selectedId: null,
  frame: 0,
  filters: {
    tournaments: new Set(),
    seasons: new Set(),
    matches: new Set(),
    player: "",
    opponent: "",
    role: "any",
    result: "any",
    number: "",
  },
  sortDirection: "asc",
};

const SOSU_SAISEI_URL = "https://searial.web.fc2.com/tools/sosusaisei.html";
const CARD_ORDER = "A23456789TJQKX";

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
}[char]));

function cardChars(value) {
  return [...String(value || "")].filter((char) => CARD_ORDER.includes(char));
}

function sortedCards(cards) {
  return [...cards].sort((a, b) => {
    const ai = CARD_ORDER.includes(a) ? CARD_ORDER.indexOf(a) : 99;
    const bi = CARD_ORDER.includes(b) ? CARD_ORDER.indexOf(b) : 99;
    return ai - bi || a.localeCompare(b);
  });
}

function cloneHands(hands) {
  return Object.fromEntries(Object.entries(hands).map(([player, cards]) => [player, sortedCards(cards)]));
}

function removeFromHand(hand, consumed) {
  const remaining = [...hand];
  const missing = [];
  for (const char of consumed) {
    const index = remaining.indexOf(char);
    if (index >= 0) remaining.splice(index, 1);
    else missing.push(char);
  }
  return { remaining, missing };
}

function representedCards(text, jokerValues) {
  const values = [...(jokerValues || [])];
  return cardChars(text).map((char) => {
    if (char !== "X") return char;
    return values.length ? values.shift() : "X";
  }).join("");
}

function cardHtml(char) {
  const cls = ["card"];
  if ("TJQK".includes(char)) cls.push("face");
  if (char === "X") cls.push("joker");
  return `<span class="${cls.join(" ")}">${esc(char)}</span>`;
}

function cardsHtml(cards) {
  const chars = Array.isArray(cards) ? cards : cardChars(cards);
  return `<div class="cards">${chars.map(cardHtml).join("") || '<span class="pill">なし</span>'}</div>`;
}

function turnSideLabel(event, game) {
  if (event.player === game.first_player) return "先";
  if (event.player === game.second_player) return "後";
  return "?";
}

function actionOutcomeBadgeHtml(event) {
  const action = String(event?.action || "");
  if (!action || action === "%") return "";
  if (cardChars(event?.penalty || "").length) {
    return '<span class="outcome-badge outcome-penalty">penalty</span>';
  }
  return '<span class="outcome-badge outcome-ok">ok</span>';
}

function routeHtml(game) {
  const events = game.events || [];
  if (!events.length) return '<span class="pill">記録なし</span>';
  const visible = events.slice(0, 4);
  const tokens = visible.map((event, index) => `
    ${index ? "<span>→</span>" : ""}
    <span class="move-token"><span class="turn-badge">${esc(turnSideLabel(event, game))}</span>${esc(event.action || event.represented_action || "%")}${actionOutcomeBadgeHtml(event)}</span>
  `);
  if (events.length > visible.length) tokens.push('<span class="route-more">…</span>');
  return `<div class="route">${tokens.join("")}</div>`;
}

function displayRawBlock(rawBlock) {
  const lines = String(rawBlock || "").split(/\r?\n/);
  if (lines[0]?.startsWith("###")) lines.shift();
  return lines.join("\n").trimStart();
}

function buildReplayFrames(game) {
  const hands = Object.fromEntries(Object.entries(game.initial_hands || {}).map(([player, cards]) => [player, cardChars(cards)]));
  let field = null;
  let revolution = false;
  const initialHands = cloneHands(hands);
  const frames = [{
    turn_index: 0,
    player: "初期状態",
    draw: null,
    action: "初期手札",
    represented_action: "",
    played_cards: [],
    consumed_cards: [],
    penalty: null,
    judgments: [],
    revolution,
    field_before: null,
    field_after: null,
    hands_before: initialHands,
    hands_after: initialHands,
    legal_status: "ok",
    notes: ["初期手札"],
    winner: false,
  }];

  (game.events || []).forEach((event, index) => {
    const turnIndex = index + 1;
    const player = String(event.player || "");
    if (!hands[player]) hands[player] = [];
    const fieldBefore = field ? { ...field, played_cards: [...(field.played_cards || [])] } : null;
    const handsBefore = cloneHands(hands);
    const notes = [];
    let legalStatus = "ok";

    const drawCards = cardChars(event.draw || "");
    if (drawCards.length) hands[player].push(...drawCards);
    if (event.revolution) {
      revolution = !revolution;
      notes.push("革命が記録されています");
    }

    const action = String(event.action || "");
    const left = action.includes("=") ? action.split("=", 1)[0] : action;
    const playedCards = cardChars(left);
    const consumedCards = action === "%" ? [] : cardChars(action);
    const represented = representedCards(playedCards.join(""), event.joker_values || []);
    const penaltyCards = cardChars(event.penalty || "");

    if (action === "%") {
      notes.push("パス");
      field = null;
    } else if (penaltyCards.length) {
      hands[player].push(...penaltyCards);
      notes.push(`ペナルティ ${penaltyCards.join("")}`);
      field = null;
    } else {
      const result = removeFromHand(hands[player], consumedCards);
      hands[player] = result.remaining;
      if (result.missing.length) {
        legalStatus = "uncertain";
        notes.push(`再構成注意: 手札にない消費カード ${result.missing.join("")}`);
      }
      if (playedCards.length) {
        field = {
          turn_index: turnIndex,
          player,
          action,
          represented_action: event.represented_action || represented,
          played_cards: playedCards,
          play_count: event.play_count,
          action_kind: event.action_kind,
          revolution,
        };
      }
    }

    const judgments = [...(event.judgments || [])];
    if (judgments.includes("GC")) {
      notes.push("GC判定が記録されています");
      field = null;
    }
    if (judgments.includes("RR")) {
      notes.push("再構成注意: RR判定が記録されています");
      legalStatus = "uncertain";
    }
    if (judgments.includes("IN")) notes.push("IN判定が記録されています");

    frames.push({
      turn_index: turnIndex,
      player,
      draw: event.draw,
      action,
      represented_action: event.represented_action || represented,
      played_cards: playedCards,
      consumed_cards: consumedCards,
      penalty: event.penalty,
      judgments,
      revolution,
      field_before: fieldBefore,
      field_after: field ? { ...field, played_cards: [...(field.played_cards || [])] } : null,
      hands_before: handsBefore,
      hands_after: cloneHands(hands),
      legal_status: legalStatus,
      notes,
      winner: Boolean(event.winner),
    });
  });
  return frames;
}

function gameHeading(game) {
  const stage = game.stage && game.tournament !== "PQCS" ? ` ${game.stage}` : "";
  return `${game.tournament} ${game.season}${stage} ${game.match_label} 第${game.match_game_no}ゲーム`;
}

async function loadData() {
  const [payload, index, facets] = await Promise.all([
    fetch("data/games.json").then((res) => res.json()),
    fetch("data/search-index.json").then((res) => res.json()),
    fetch("data/facets.json").then((res) => res.json()),
  ]);
  state.payload = payload;
  state.games = payload.games || [];
  state.index = index || [];
  state.facets = facets || {};
  state.selectedId = state.games[0]?.id || null;
  renderFilters();
  render();
}

function checkedSetHtml(name, values, selected, labeler = (value) => value) {
  return `<div class="filter-body compact-checks">${values.map((value) => `
    <label class="check-row">
      <input type="checkbox" data-filter="${esc(name)}" value="${esc(value)}" ${selected.has(String(value)) ? "checked" : ""}>
      <span>${esc(labeler(value))}</span>
    </label>`).join("")}</div>`;
}

function selectedHierarchyRows() {
  const rows = state.facets.hierarchy || [];
  const tournaments = state.filters.tournaments;
  const seasons = state.filters.seasons;
  return {
    tournamentRows: rows,
    seasonRows: rows.filter((row) => tournaments.has(String(row.tournament))),
    matchRows: rows.filter((row) => (
      tournaments.has(String(row.tournament))
      && seasons.has(`${row.tournament}||${row.season}||${row.stage || ""}`)
    )),
  };
}

function renderTournamentFilters() {
  const { tournamentRows, seasonRows, matchRows } = selectedHierarchyRows();
  const tournaments = [...new Set(tournamentRows.map((row) => row.tournament))];
  const seasons = seasonRows.map((row) => ({
    key: `${row.tournament}||${row.season}||${row.stage || ""}`,
    label: `${row.tournament} ${row.season}${row.stage ? ` ${row.stage}` : ""}`,
  }));
  const matches = matchRows.flatMap((row) => row.matches.map((match) => ({
    key: match.match_id,
    label: `${row.tournament} ${row.season}${row.stage ? ` ${row.stage}` : ""} ${match.label} (${match.players.join(" vs ")}, ${match.game_count}局)`,
  })));

  return `<section class="filter-group">
    <div class="filter-title static-title"><span>大会</span><span>${tournaments.length}</span></div>
    ${checkedSetHtml("tournament", tournaments, state.filters.tournaments)}
    ${state.filters.tournaments.size ? `<div class="filter-subtitle">期</div>${checkedSetHtml("season", seasons.map((item) => item.key), state.filters.seasons, (value) => seasons.find((item) => item.key === value)?.label || value)}` : ""}
    ${state.filters.seasons.size ? `<div class="filter-subtitle">試合</div>${checkedSetHtml("match", matches.map((item) => item.key), state.filters.matches, (value) => matches.find((item) => item.key === value)?.label || value)}` : ""}
  </section>`;
}

function renderPlayerFilters() {
  const players = state.facets.player || [];
  const opponents = state.filters.player
    ? [...new Set(state.games
      .filter((game) => game.players.includes(state.filters.player))
      .flatMap((game) => game.players.filter((player) => player !== state.filters.player)))]
      .sort((a, b) => String(a).localeCompare(String(b), "ja"))
    : [];
  return `<section class="filter-group">
    <div class="filter-title static-title"><span>プレイヤー</span><span>${players.length}</span></div>
    <div class="player-grid">
      <label>1人目
        <select id="playerSelect">
          <option value="">指定なし</option>
          ${players.map((player) => `<option value="${esc(player)}" ${state.filters.player === player ? "selected" : ""}>${esc(player)}</option>`).join("")}
        </select>
      </label>
      ${state.filters.player ? `<label>相手
        <select id="opponentSelect">
          <option value="">指定なし</option>
          ${opponents.map((player) => `<option value="${esc(player)}" ${state.filters.opponent === player ? "selected" : ""}>${esc(player)}</option>`).join("")}
        </select>
      </label>
      <label>手番
        <select id="roleSelect">
          <option value="any" ${state.filters.role === "any" ? "selected" : ""}>指定なし</option>
          <option value="first" ${state.filters.role === "first" ? "selected" : ""}>1人目が先手</option>
          <option value="second" ${state.filters.role === "second" ? "selected" : ""}>1人目が後手</option>
        </select>
      </label>
      <label>勝敗
        <select id="resultSelect">
          <option value="any" ${state.filters.result === "any" ? "selected" : ""}>指定なし</option>
          <option value="win" ${state.filters.result === "win" ? "selected" : ""}>1人目勝ち</option>
          <option value="loss" ${state.filters.result === "loss" ? "selected" : ""}>1人目負け</option>
        </select>
      </label>` : ""}
    </div>
    <div class="number-filter">
      <label>出た数・札
        <input id="numberInput" type="search" inputmode="text" value="${esc(state.filters.number)}" placeholder="例: 5923 / QK / KJQJ">
      </label>
      <p>その試合で一度でも出た数、または札の組み合わせで絞り込みます。</p>
    </div>
  </section>`;
}

function renderFilters() {
  $("#filters").innerHTML = renderTournamentFilters() + renderPlayerFilters();
}

function updateSetFilter(kind, value, checked) {
  const key = kind === "tournament" ? "tournaments" : kind === "season" ? "seasons" : "matches";
  if (checked) state.filters[key].add(value);
  else state.filters[key].delete(value);
  if (kind === "tournament") {
    state.filters.seasons.clear();
    state.filters.matches.clear();
  }
  if (kind === "season") {
    state.filters.matches.clear();
  }
}

function docMatchesHierarchy(doc) {
  if (state.filters.tournaments.size && !state.filters.tournaments.has(String(doc.tournament))) return false;
  if (state.filters.seasons.size) {
    const seasonKey = `${doc.tournament}||${doc.season}||${doc.stage || ""}`;
    if (!state.filters.seasons.has(seasonKey)) return false;
  }
  if (state.filters.matches.size && !state.filters.matches.has(String(doc.match_id))) return false;
  return true;
}

function docMatchesPlayer(doc) {
  const player = state.filters.player;
  if (!player) return true;
  if (!doc.players?.includes(player)) return false;
  if (state.filters.opponent && !doc.players?.includes(state.filters.opponent)) return false;
  if (state.filters.role === "first" && doc.first_player !== player) return false;
  if (state.filters.role === "second" && doc.second_player !== player) return false;
  if (state.filters.result === "win" && doc.winner !== player) return false;
  if (state.filters.result === "loss" && doc.winner === player) return false;
  return true;
}

function docMatchesQuery(doc, query) {
  if (!query) return true;
  const normalized = query.trim().toLowerCase();
  return (doc.played_entries || []).some((entry) => (
    String(entry.number || "").toLowerCase() === normalized
    || String(entry.cards || "").toLowerCase() === normalized
    || String(entry.action || "").toLowerCase() === normalized
    || String(entry.represented_action || "").toLowerCase() === normalized
  ));
}

function filteredRows() {
  const query = state.filters.number;
  const rows = state.index
    .map((doc, index) => ({ doc, game: state.games[index] }))
    .filter(({ doc }) => docMatchesQuery(doc, query) && docMatchesHierarchy(doc) && docMatchesPlayer(doc));
  const sort = $("#sortSelect").value;
  const direction = state.sortDirection === "desc" ? -1 : 1;
  const gameOrderCompare = (a, b) => (
    String(a.game.tournament || "").localeCompare(String(b.game.tournament || ""), "ja")
    || String(a.game.season || "").localeCompare(String(b.game.season || ""), "ja")
    || Number(a.game.stage_order || 0) - Number(b.game.stage_order || 0)
    || Number(a.game.match_no) - Number(b.game.match_no)
    || Number(a.game.match_game_no) - Number(b.game.match_game_no)
  );
  rows.sort((a, b) => {
    let result;
    if (sort === "win") {
      result = String(a.game.winner || "").localeCompare(String(b.game.winner || ""), "ja")
        || gameOrderCompare(a, b);
    } else if (sort === "updated") {
      result = String(a.game.source || "").localeCompare(String(b.game.source || ""), "ja")
        || Number(a.game.game_no) - Number(b.game.game_no)
        || gameOrderCompare(a, b);
    } else if (sort === "turns") {
      result = (a.game.events?.length || 0) - (b.game.events?.length || 0)
        || gameOrderCompare(a, b);
    } else {
      result = gameOrderCompare(a, b);
    }
    return result * direction;
  });
  return rows;
}

function renderResults(rows) {
  $("#resultMeta").textContent = `${rows.length} / ${state.games.length} 局`;
  if (!rows.length) {
    $("#resultsList").innerHTML = '<div class="empty-results">該当する数譜がありません。</div>';
    return;
  }
  $("#resultsList").innerHTML = rows.map(({ game }) => `
    <button class="result-card" type="button" data-game-id="${esc(game.id)}" aria-selected="${game.id === state.selectedId}">
      <div class="result-title">
        <span>${esc(gameHeading(game))}</span>
        <span class="pill">${esc(game.first_player)} vs ${esc(game.second_player)}</span>
        <span class="pill ${game.winner === game.first_player ? "win" : "lose"}">winner ${esc(game.winner || "-")}</span>
      </div>
      ${routeHtml(game)}
    </button>
  `).join("");
}

function selectedGame() {
  return state.games.find((game) => game.id === state.selectedId) || state.games[0];
}

function renderDetail() {
  const game = selectedGame();
  if (!game) return;
  const frames = buildReplayFrames(game);
  state.frame = Math.min(state.frame, Math.max(0, frames.length - 1));
  const frame = frames[state.frame];
  $("#detailPanel").innerHTML = `<article class="detail-card">
    <h2>${esc(gameHeading(game))}</h2>
    <div class="result-title">
      <span class="pill">${esc(game.first_player)} vs ${esc(game.second_player)}</span>
      <span class="pill ${game.winner === game.first_player ? "win" : "lose"}">winner ${esc(game.winner || "-")}</span>
    </div>
    <section class="detail-section">
      <h3>一手ごと再生</h3>
      ${renderReplayControls(frames)}
      ${frame ? renderFrame(frame) : '<div class="frame-box">再生フレームなし</div>'}
    </section>
    <section class="detail-section">
      <h3>外部再生</h3>
      <div class="external-actions">
        <button type="button" data-copy-kifu>数譜をコピー</button>
        <a class="button-link" href="${SOSU_SAISEI_URL}" target="_blank" rel="noopener noreferrer">数譜再生くんを開く</a>
        <span id="copyStatus" class="copy-status" aria-live="polite"></span>
      </div>
    </section>
    <section class="detail-section">
      <h3>元数譜</h3>
      <pre class="raw-kifu">${esc(displayRawBlock(game.raw_block))}</pre>
    </section>
  </article>`;
}

function renderReplayControls(frames) {
  const max = Math.max(0, frames.length - 1);
  return `<div class="replay-controls">
    <button type="button" data-step="-1" aria-label="前へ">‹</button>
    <button type="button" data-step="1" aria-label="次へ">›</button>
    <input class="replay-slider" type="range" min="0" max="${max}" value="${state.frame}" data-frame-slider>
    <span>${frames.length ? state.frame + 1 : 0}/${frames.length}</span>
  </div>`;
}

function fieldHtml(field) {
  if (!field) return '<span class="pill">場なし</span>';
  return `<span class="move-token">${esc(field.represented_action || field.action)}</span><span class="pill">${esc(field.player)}</span>`;
}

function renderFrame(frame) {
  if (Number(frame.turn_index) === 0) {
    return `<div class="frame-box">
      <div class="result-title">
        <strong>初期状態</strong>
      </div>
      <div class="detail-section">
        <h3>手札</h3>
        <div class="hands">${Object.entries(frame.hands_after || {}).map(([player, cards]) => `<div class="hand-row"><strong>${esc(player)} (${cards.length})</strong>${cardsHtml(cards)}</div>`).join("")}</div>
      </div>
    </div>`;
  }
  return `<div class="frame-box">
    <div class="result-title">
      <strong>${esc(frame.turn_index)}. ${esc(frame.player)}</strong>
      ${frame.draw ? `<span class="pill">D(${esc(frame.draw)})</span>` : ""}
      <span class="move-token">${esc(frame.action || "%")}${actionOutcomeBadgeHtml(frame)}</span>
      ${frame.winner ? '<span class="pill win">上がり</span>' : ""}
    </div>
    <div class="detail-section">
      <h3>場</h3>
      <div class="route">${fieldHtml(frame.field_before)}<span>→</span>${fieldHtml(frame.field_after)}</div>
    </div>
    <div class="detail-section">
      <h3>手札</h3>
      <div class="hands">${Object.entries(frame.hands_after || {}).map(([player, cards]) => `<div class="hand-row"><strong>${esc(player)} (${cards.length})</strong>${cardsHtml(cards)}</div>`).join("")}</div>
    </div>
    ${frame.notes?.length ? `<div class="detail-section"><h3>注記</h3>${frame.notes.map((note) => `<span class="pill">${esc(note)}</span>`).join(" ")}</div>` : ""}
  </div>`;
}

function render() {
  const keepNumberFocus = document.activeElement?.id === "numberInput";
  if (!keepNumberFocus) {
    renderFilters();
  }
  const rows = filteredRows();
  if (!rows.some(({ game }) => game.id === state.selectedId)) {
    state.selectedId = rows[0]?.game.id || state.games[0]?.id || null;
    state.frame = 0;
  }
  $("#statusText").textContent = `${state.games.length}局 / ${state.facets.hierarchy?.length || 0}カテゴリ`;
  $("#sortDirectionButton").textContent = state.sortDirection === "asc" ? "▲" : "▼";
  $("#sortDirectionButton").setAttribute("aria-label", state.sortDirection === "asc" ? "昇順" : "降順");
  renderDetail();
  renderResults(rows);
}

$("#sortSelect").addEventListener("change", render);
$("#sortDirectionButton").addEventListener("click", () => {
  state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
  render();
});
$("#filters").addEventListener("change", (event) => {
  const target = event.target;
  if (target.matches("[data-filter]")) {
    updateSetFilter(target.dataset.filter, target.value, target.checked);
    render();
    return;
  }
  if (target.id === "playerSelect") {
    state.filters.player = target.value;
    state.filters.opponent = "";
    state.filters.role = "any";
    state.filters.result = "any";
  }
  if (target.id === "opponentSelect") state.filters.opponent = target.value;
  if (target.id === "roleSelect") state.filters.role = target.value;
  if (target.id === "resultSelect") state.filters.result = target.value;
  render();
});
$("#filters").addEventListener("input", (event) => {
  const target = event.target;
  if (target.id !== "numberInput") return;
  state.filters.number = target.value;
  render();
});
$("#resultsList").addEventListener("click", (event) => {
  const card = event.target.closest("[data-game-id]");
  if (!card) return;
  state.selectedId = card.dataset.gameId;
  state.frame = 0;
  render();
});
$("#detailPanel").addEventListener("click", async (event) => {
  const stepButton = event.target.closest("[data-step]");
  if (stepButton) {
    const game = selectedGame();
    const frames = buildReplayFrames(game);
    const max = Math.max(0, frames.length - 1);
    state.frame = Math.max(0, Math.min(max, state.frame + Number(stepButton.dataset.step || 0)));
    renderDetail();
    return;
  }
  const copyButton = event.target.closest("[data-copy-kifu]");
  if (!copyButton) return;
  const game = selectedGame();
  try {
    await navigator.clipboard.writeText(displayRawBlock(game.raw_block || ""));
    $("#copyStatus").textContent = "コピーしました";
  } catch {
    $("#copyStatus").textContent = "コピーできませんでした";
  }
});
$("#detailPanel").addEventListener("input", (event) => {
  const slider = event.target.closest("[data-frame-slider]");
  if (!slider) return;
  state.frame = Number(slider.value || 0);
  renderDetail();
});

loadData().catch((error) => {
  console.error(error);
  $("#statusText").textContent = "読み込みに失敗しました";
  $("#detailPanel").innerHTML = '<div class="empty-detail">データを読み込めませんでした。</div>';
});
