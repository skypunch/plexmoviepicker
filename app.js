'use strict';

/* ---------------------------------------------------------------------------
 * Plex Movie Picker — pure client-side, PIN-based Plex OAuth.
 * ------------------------------------------------------------------------- */

const APP_NAME = 'Plex Movie Picker';

const KEY_CLIENT_ID = 'plexpick.clientId';
const KEY_TOKEN = 'plexpick.token';
const KEY_SERVER = 'plexpick.serverUrl';
const KEY_SERVER_TOKEN = 'plexpick.serverToken';
const KEY_PIN_ID = 'plexpick.pinId'; // sessionStorage

const PIN_POLL_INTERVAL_MS = 1500;
const PIN_POLL_TIMEOUT_MS = 2 * 60 * 1000;
const LIBRARY_REFRESH_MS = 5 * 60 * 1000;
const LIBRARY_REFRESH_MIN_AGE_MS = 60 * 1000;
const SHUFFLE_FRAMES = 6;
const SHUFFLE_FRAME_MS = 160;
const MAX_SHORT_RUNTIME_MS = 100 * 60 * 1000;
const NO_MATCH_MESSAGE = 'No movies match the current filters.';

class AuthError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'AuthError';
  }
}

/** A discovery failure whose message is safe to show to the user as-is. */
class DiscoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

const state = {
  token: null, // plex.tv account token
  serverToken: null, // token for the media server (differs on shared servers)
  baseUrl: null,
  movies: null,
  moviesLoadedAt: 0,
};

/* ------------------------------- DOM refs -------------------------------- */

const els = {
  status: document.getElementById('status'),
  signinView: document.getElementById('signin-view'),
  signinBtn: document.getElementById('signin-btn'),
  pickerView: document.getElementById('picker-view'),
  result: document.getElementById('result'),
  poster: document.getElementById('poster'),
  posterPlaceholder: document.getElementById('poster-placeholder'),
  movieTitle: document.getElementById('movie-title'),
  movieMeta: document.getElementById('movie-meta'),
  pickBtn: document.getElementById('pick-btn'),
  filterRuntime: document.getElementById('filter-runtime'),
  filterComedy: document.getElementById('filter-comedy'),
  filterHorror: document.getElementById('filter-horror'),
  libraryInfo: document.getElementById('library-info'),
  signoutLink: document.getElementById('signout-link'),
};

const filters = {
  shortOnly: false, // 100 minutes and under
  comedyOnly: false,
  horrorOnly: false,
};

function hasGenre(movie, tag) {
  return (movie.Genre || []).some((g) => String(g.tag).toLowerCase() === tag);
}

function filteredMovies() {
  let list = state.movies || [];
  if (filters.shortOnly) {
    list = list.filter((m) => m.duration && m.duration <= MAX_SHORT_RUNTIME_MS);
  }
  if (filters.comedyOnly) {
    list = list.filter((m) => hasGenre(m, 'comedy'));
  }
  if (filters.horrorOnly) {
    list = list.filter((m) => hasGenre(m, 'horror'));
  }
  return list;
}

/* ------------------------------- Utilities ------------------------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uuidv4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback: RFC 4122 v4 from raw random bytes.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

function getClientId() {
  let id = localStorage.getItem(KEY_CLIENT_ID);
  if (!id) {
    id = uuidv4();
    localStorage.setItem(KEY_CLIENT_ID, id);
  }
  return id;
}

/**
 * Uniform random index in [0, n) via crypto.getRandomValues with rejection
 * sampling: draws >= the largest multiple of n that fits in 2^32 are
 * rejected and redrawn, eliminating modulo bias.
 */
function secureRandomIndex(n) {
  if (n <= 0) throw new Error('secureRandomIndex: empty range');
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % n;
}

function formatRuntime(durationMs) {
  const totalMinutes = Math.round(durationMs / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/* --------------------------------- UI ------------------------------------ */

function showStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
  els.status.hidden = !message;
}

function clearStatus() {
  showStatus('');
}

function showSignInView(message, isError = false) {
  els.pickerView.hidden = true;
  els.signinView.hidden = false;
  showStatus(message || '', isError);
}

function showPickerView() {
  els.signinView.hidden = true;
  els.pickerView.hidden = false;
}

function posterUrl(movie) {
  return `${state.baseUrl}${movie.thumb}?X-Plex-Token=${encodeURIComponent(state.serverToken)}`;
}

function showMovie(movie, shuffling) {
  els.result.hidden = false;
  els.result.classList.toggle('shuffling', shuffling);

  if (movie.thumb) {
    els.poster.src = posterUrl(movie);
    els.poster.hidden = false;
    els.posterPlaceholder.hidden = true;
  } else {
    els.poster.hidden = true;
    els.posterPlaceholder.hidden = false;
  }

  els.movieTitle.textContent = movie.title || 'Untitled';

  const parts = [];
  if (movie.year) parts.push(String(movie.year));
  if (movie.duration) parts.push(formatRuntime(movie.duration));
  if (movie.contentRating) parts.push(movie.contentRating);
  els.movieMeta.textContent = parts.join(' · ');
}

/* --------------------------- plex.tv API calls ---------------------------- */

function plexTvHeaders() {
  return {
    Accept: 'application/json',
    'X-Plex-Product': APP_NAME,
    'X-Plex-Client-Identifier': getClientId(),
  };
}

async function startSignIn() {
  els.signinBtn.disabled = true;
  showStatus('Contacting Plex…');
  try {
    const params = new URLSearchParams({
      strong: 'true',
      'X-Plex-Product': APP_NAME,
      'X-Plex-Client-Identifier': getClientId(),
    });
    const res = await fetch(`https://plex.tv/api/v2/pins?${params}`, {
      method: 'POST',
      headers: plexTvHeaders(),
    });
    if (!res.ok) throw new Error(`PIN request failed (${res.status})`);
    const pin = await res.json();

    sessionStorage.setItem(KEY_PIN_ID, String(pin.id));

    const forwardUrl = location.origin + location.pathname + location.search;
    const authUrl =
      'https://app.plex.tv/auth#?' +
      `clientID=${encodeURIComponent(getClientId())}` +
      `&code=${encodeURIComponent(pin.code)}` +
      `&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(APP_NAME)}` +
      `&forwardUrl=${encodeURIComponent(forwardUrl)}`;
    location.href = authUrl;
  } catch (err) {
    els.signinBtn.disabled = false;
    showStatus(`Could not start sign-in: ${err.message}`, true);
  }
}

/** Poll the PIN until it carries an authToken. Returns the token or null. */
async function pollPin(pinId) {
  const deadline = Date.now() + PIN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`https://plex.tv/api/v2/pins/${pinId}`, {
        headers: plexTvHeaders(),
      });
      if (res.status === 404) return null; // PIN expired or was consumed
      if (res.ok) {
        const data = await res.json();
        if (data.authToken) return data.authToken;
      }
    } catch {
      // Transient network error — keep polling until the deadline.
    }
    await sleep(PIN_POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * Find the user's Plex Media Server. Returns its HTTPS *.plex.direct base
 * URL plus the token to use against it — shared (non-owned) servers reject
 * the account token and require the resource's own accessToken. Prefers the
 * first owned server and remote (local: false) connections.
 */
async function discoverServer() {
  const res = await fetch('https://plex.tv/api/v2/resources?includeHttps=1', {
    headers: { ...plexTvHeaders(), 'X-Plex-Token': state.token },
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Resource discovery failed (${res.status})`);
  const resources = await res.json();

  const servers = resources.filter((r) =>
    String(r.provides || '').split(',').includes('server')
  );
  const server = servers.find((s) => s.owned) || servers[0];
  if (!server) {
    throw new DiscoveryError('No Plex Media Server is linked to this account.');
  }

  const candidates = (server.connections || []).filter((c) => {
    if (c.protocol !== 'https') return false;
    try {
      return new URL(c.uri).hostname.endsWith('.plex.direct');
    } catch {
      return false;
    }
  });
  const conn = candidates.find((c) => c.local === false) || candidates[0];
  if (!conn) {
    throw new DiscoveryError(
      'No secure (plex.direct) connection found for your server. ' +
        'Check that "Secure connections" is enabled in your server settings.'
    );
  }
  return { uri: conn.uri, accessToken: server.accessToken || state.token };
}

/* ------------------------------ PMS API calls ----------------------------- */

// The token rides the query string here on purpose: a custom X-Plex-Token
// header would trigger a CORS preflight, which PMS does not reliably handle
// (Plex's own web clients use query params against PMS for the same reason).
async function pmsFetch(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(
    `${state.baseUrl}${path}${sep}X-Plex-Token=${encodeURIComponent(state.serverToken)}`,
    { headers: { Accept: 'application/json' } }
  );
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`Server responded with ${res.status}`);
  return res.json();
}

async function fetchMovies() {
  const sections = await pmsFetch('/library/sections');
  const movieSections = (sections.MediaContainer?.Directory || []).filter(
    (d) => d.type === 'movie'
  );
  if (movieSections.length === 0) return [];
  const lists = await Promise.all(
    movieSections.map((s) => pmsFetch(`/library/sections/${s.key}/all`))
  );
  return lists.flatMap((l) => l.MediaContainer?.Metadata || []);
}

/**
 * Load the movie list, resolving the server URL first. If the cached server
 * URL fails for a non-auth reason, re-discover once and retry.
 */
async function loadLibrary() {
  const cachedUrl = localStorage.getItem(KEY_SERVER);
  const cachedToken = localStorage.getItem(KEY_SERVER_TOKEN);
  if (cachedUrl && cachedToken) {
    state.baseUrl = cachedUrl;
    state.serverToken = cachedToken;
    try {
      return await fetchMovies();
    } catch (err) {
      if (err instanceof AuthError) throw err;
      localStorage.removeItem(KEY_SERVER);
      localStorage.removeItem(KEY_SERVER_TOKEN);
    }
  }
  const server = await discoverServer();
  state.baseUrl = server.uri;
  state.serverToken = server.accessToken;
  localStorage.setItem(KEY_SERVER, state.baseUrl);
  localStorage.setItem(KEY_SERVER_TOKEN, state.serverToken);
  return fetchMovies();
}

/* ------------------------------- App flow -------------------------------- */

function signOut(message, isError = false) {
  localStorage.removeItem(KEY_TOKEN);
  localStorage.removeItem(KEY_SERVER);
  localStorage.removeItem(KEY_SERVER_TOKEN);
  sessionStorage.removeItem(KEY_PIN_ID);
  state.token = null;
  state.serverToken = null;
  state.baseUrl = null;
  state.movies = null;
  filters.shortOnly = false;
  filters.comedyOnly = false;
  filters.horrorOnly = false;
  els.filterRuntime.setAttribute('aria-pressed', 'false');
  els.filterComedy.setAttribute('aria-pressed', 'false');
  els.filterHorror.setAttribute('aria-pressed', 'false');
  els.result.hidden = true;
  els.pickBtn.disabled = true;
  els.pickBtn.textContent = 'Pick a film';
  els.libraryInfo.textContent = '';
  els.signinBtn.disabled = false;
  showSignInView(message, isError);
}

async function enterApp() {
  showPickerView();
  showStatus('Loading your library…');
  els.pickBtn.disabled = true;
  els.pickBtn.textContent = 'Pick a film';
  try {
    state.movies = await loadLibrary();
  } catch (err) {
    if (err instanceof AuthError) {
      signOut('Your session expired — please sign in again.', true);
      return;
    }
    const message =
      err instanceof DiscoveryError
        ? err.message
        : 'Could not reach your Plex server. It may be offline, or "Secure ' +
          'connections" may not be enabled in its network settings.';
    showStatus(message, true);
    els.pickBtn.textContent = 'Try again';
    els.pickBtn.disabled = false;
    return;
  }

  if (state.movies.length === 0) {
    showStatus('No movies found in your Plex library.', true);
    return;
  }

  state.moviesLoadedAt = Date.now();
  clearStatus();
  updateLibraryInfo();
  els.pickBtn.disabled = false;
  await pickMovie(); // pick straight away — no need to press the button first
}

function updateLibraryInfo() {
  if (!state.movies) {
    els.libraryInfo.textContent = '';
    return;
  }
  const total = state.movies.length;
  if (filters.shortOnly || filters.comedyOnly || filters.horrorOnly) {
    els.libraryInfo.textContent = `${filteredMovies().length} of ${total} films ·`;
  } else {
    els.libraryInfo.textContent = `${total} ${total === 1 ? 'film' : 'films'} ·`;
  }
}

function toggleFilter(btn, key) {
  filters[key] = !filters[key];
  btn.setAttribute('aria-pressed', String(filters[key]));
  updateLibraryInfo();
  // Clear a stale "no matches" complaint once the filters allow picks again.
  if (filteredMovies().length > 0 && els.status.textContent === NO_MATCH_MESSAGE) {
    clearStatus();
  }
}

let refreshingLibrary = false;

/**
 * Silently re-fetch the movie list so a long-lived tab stays current.
 * Runs on tab refocus and on a timer; failures keep the existing list
 * working — only an auth failure ends the session.
 */
async function refreshLibrary() {
  if (!state.token || !state.movies || refreshingLibrary) return;
  if (document.hidden) return;
  if (Date.now() - state.moviesLoadedAt < LIBRARY_REFRESH_MIN_AGE_MS) return;
  refreshingLibrary = true;
  try {
    const movies = await loadLibrary();
    if (movies.length > 0) {
      state.movies = movies;
      state.moviesLoadedAt = Date.now();
      updateLibraryInfo();
    }
  } catch (err) {
    if (err instanceof AuthError) {
      signOut('Your session expired — please sign in again.', true);
    }
  } finally {
    refreshingLibrary = false;
  }
}

async function pickMovie() {
  if (!state.movies || state.movies.length === 0) {
    // The button reads "Try again" after a failed library load.
    enterApp();
    return;
  }

  const movies = filteredMovies();
  if (movies.length === 0) {
    showStatus(NO_MATCH_MESSAGE, true);
    return;
  }
  if (els.status.textContent === NO_MATCH_MESSAGE) clearStatus();

  els.pickBtn.disabled = true;
  const winner = movies[secureRandomIndex(movies.length)];

  // Shuffle animation: flash a few random posters before the reveal.
  const teasers = [];
  for (let i = 0; i < SHUFFLE_FRAMES; i++) {
    teasers.push(movies[secureRandomIndex(movies.length)]);
  }
  for (const m of teasers) {
    if (m.thumb) new Image().src = posterUrl(m); // warm the cache
  }
  for (const m of teasers) {
    showMovie(m, true);
    await sleep(SHUFFLE_FRAME_MS);
    if (!state.token) return; // signed out mid-shuffle
  }

  showMovie(winner, false);
  els.pickBtn.textContent = 'Pick another movie';
  els.pickBtn.disabled = false;
}

async function init() {
  getClientId(); // ensure the client identifier exists from first load

  els.signinBtn.addEventListener('click', startSignIn);
  els.pickBtn.addEventListener('click', pickMovie);
  els.filterRuntime.addEventListener('click', () =>
    toggleFilter(els.filterRuntime, 'shortOnly')
  );
  els.filterComedy.addEventListener('click', () =>
    toggleFilter(els.filterComedy, 'comedyOnly')
  );
  els.filterHorror.addEventListener('click', () =>
    toggleFilter(els.filterHorror, 'horrorOnly')
  );
  els.signoutLink.addEventListener('click', (e) => {
    e.preventDefault();
    signOut();
  });
  els.poster.addEventListener('error', () => {
    els.poster.hidden = true;
    els.posterPlaceholder.hidden = false;
  });
  document.addEventListener('visibilitychange', refreshLibrary);
  setInterval(refreshLibrary, LIBRARY_REFRESH_MS);

  state.token = localStorage.getItem(KEY_TOKEN);
  if (state.token) {
    enterApp();
    return;
  }

  // Returning from the Plex auth page: finish the PIN handshake.
  const pinId = sessionStorage.getItem(KEY_PIN_ID);
  if (pinId) {
    els.signinView.hidden = true;
    showStatus('Completing sign-in…');
    const token = await pollPin(pinId);
    sessionStorage.removeItem(KEY_PIN_ID);
    if (token) {
      localStorage.setItem(KEY_TOKEN, token);
      state.token = token;
      enterApp();
    } else {
      showSignInView('Sign-in was cancelled or timed out — please try again.', true);
    }
    return;
  }

  showSignInView();
}

init();
