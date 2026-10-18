// ==UserScript==
// @name         Jiten Everywhere
// @namespace    https://github.com/nerenar/jiten-everywhere
// @license      MIT
// @version      0.1.0
// @description  Show Jiten stats (character count, difficulty, coverage...) on VNDB, AniList, MyAnimeList, TMDB, IMDb, Letterboxd, IGDB, Syosetu and Bookmeter, and request missing works on Jiten with the form prefilled.
// @author       nerenar
// @match        https://vndb.org/*
// @match        https://anilist.co/*
// @match        https://myanimelist.net/anime/*
// @match        https://myanimelist.net/manga/*
// @match        https://www.themoviedb.org/movie/*
// @match        https://www.themoviedb.org/tv/*
// @match        https://www.imdb.com/*
// @match        https://letterboxd.com/film/*
// @match        https://www.igdb.com/*
// @match        https://ncode.syosetu.com/*
// @match        https://bookmeter.com/books/*
// @match        https://jiten.moe/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.registerMenuCommand
// @grant        GM.openInTab
// @connect      api.jiten.moe
// @connect      graphql.anilist.co
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Jiten enums (Jiten.Core/Data/LinkType.cs, MediaType.cs, MediaRequestStatus.cs)
  // ---------------------------------------------------------------------------

  const LINK = { VNDB: 2, TMDB: 3, ANILIST: 4, MAL: 5, IMDB: 7, IGDB: 8, SYOSETU: 9, BOOKMETER: 10, AMAZON: 11 };
  const MT = {
    ANIME: 1, DRAMA: 2, MOVIE: 3, NOVEL: 4, NONFICTION: 5, VIDEOGAME: 6,
    VN: 7, WEBNOVEL: 8, MANGA: 9, AUDIO: 10, YOUTUBE: 11,
  };
  const MT_LABEL = {
    1: 'Anime', 2: 'Drama', 3: 'Movie', 4: 'Novel', 5: 'Non-Fiction', 6: 'Video Game',
    7: 'Visual Novel', 8: 'Web Novel', 9: 'Manga', 10: 'Audio', 11: 'YouTube',
  };
  const REQUEST_STATUS = { 1: 'open', 2: 'in progress', 3: 'completed', 4: 'rejected' };
  const DECK_STATUS = [[0, 'Not in list'], [1, 'Planning'], [2, 'Ongoing'], [5, 'Paused'], [3, 'Completed'], [4, 'Dropped']];
  const ACTIVE_REQUEST = [1, 2];

  const COMPATIBLE = {
    [MT.ANIME]: [MT.ANIME, MT.MOVIE],
    [MT.MOVIE]: [MT.MOVIE, MT.ANIME, MT.DRAMA],
    [MT.DRAMA]: [MT.DRAMA, MT.MOVIE],
    [MT.NOVEL]: [MT.NOVEL, MT.NONFICTION, MT.WEBNOVEL],
    [MT.NONFICTION]: [MT.NONFICTION, MT.NOVEL],
    [MT.WEBNOVEL]: [MT.WEBNOVEL, MT.NOVEL],
    [MT.MANGA]: [MT.MANGA],
    [MT.VN]: [MT.VN, MT.VIDEOGAME],
    [MT.VIDEOGAME]: [MT.VIDEOGAME, MT.VN],
  };
  const isCompatible = (info, deckType) =>
    (!info.mediaType || !COMPATIBLE[info.mediaType] || COMPATIBLE[info.mediaType].includes(deckType))
    && (!info.siteTypes || info.siteTypes.includes(deckType));

  const TIMED_SPEECH = [MT.ANIME, MT.DRAMA, MT.MOVIE, MT.AUDIO, MT.YOUTUBE];
  const READING = [MT.NOVEL, MT.NONFICTION, MT.VN, MT.WEBNOVEL];
  const DIFFICULTY_NAMES = ['Beginner', 'Easy', 'Average', 'Hard', 'Expert', 'Insane'];

  const JITEN = 'https://jiten.moe';
  const JITEN_API = 'https://api.jiten.moe/api';

  // ---------------------------------------------------------------------------
  // Text helpers
  // ---------------------------------------------------------------------------

  const JP_RE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;
  const hasJapanese = (s) => !!s && JP_RE.test(s);
  const KANA_RE = /[぀-ヿｦ-ﾟ]/;
  const hasKana = (s) => !!s && KANA_RE.test(s);
  const clean = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
  const fmt = (n) => Number(n).toLocaleString('en-US');

  const normalizeTitle = (s) => clean(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

  function titleStrength(queries, deck) {
    const names = [deck.originalTitle, deck.romajiTitle, deck.englishTitle, deck.title].map(normalizeTitle).filter(Boolean);
    let best = 0;
    for (const q of queries.map(normalizeTitle).filter(Boolean)) {
      for (const n of names) {
        if (n === q) return 2;
        if (Math.min(n.length, q.length) >= 4 && (n.includes(q) || q.includes(n))) best = 1;
      }
    }
    return best;
  }

  // From "VNDB Character Count" by Sirus (MIT).
  function formatTime(hours) {
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (m === 0) return `${h}h`;
    if (m === 60) return `${h + 1}h`;
    return `${h}h ${m}m`;
  }

  function formatSpeech(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  function difficultyText(d) {
    const v = d.difficultyRaw ?? d.difficulty;
    if (v == null || v < 0) return null;
    const band = Math.min(Math.max(Math.floor(v), 0), DIFFICULTY_NAMES.length - 1);
    return `${v.toFixed(1)}/5 · ${DIFFICULTY_NAMES[band]}`;
  }

  const WATCHED = [MT.ANIME, MT.DRAMA, MT.MOVIE, MT.AUDIO, MT.YOUTUBE];
  function progressText(d) {
    const e = d.listEntry;
    if (!e) return null;
    const parts = [];
    if (e.state === 0) {
      const chars = Math.max(e.charactersRead || 0, e.volumeCharacters || 0);
      const units = childLabel(d.mediaType)?.toLowerCase() || 'parts';
      if (e.unitCount) parts.push(`${e.completedUnits || 0} of ${e.unitCount} ${units}`);
      else if (chars > 0 && d.characterCount > 0) {
        const pct = `${Math.min(100, Math.max(1, Math.floor((chars * 100) / d.characterCount)))}%`;
        parts.push(d.mediaType === MT.VN ? `${pct} (${fmt(chars)})` : pct);
      }
    }
    if (e.completedCount > 0) {
      const past = d.mediaType === MT.AUDIO ? 'Listened to' : WATCHED.includes(d.mediaType) ? 'Watched' : d.mediaType === MT.VIDEOGAME ? 'Played' : 'Read';
      parts.push(`${past} ${e.completedCount === 1 ? 'once' : e.completedCount === 2 ? 'twice' : `${e.completedCount} times`}`);
    }
    return parts.length ? parts.join(' · ') : null;
  }

  const childLabel = (type) => ([MT.ANIME, MT.DRAMA].includes(type) ? 'Episodes'
    : [MT.NOVEL, MT.NONFICTION, MT.MANGA].includes(type) ? 'Volumes' : null);

  // ---------------------------------------------------------------------------
  // External links: how Jiten stores them, and which page a URL is
  // ---------------------------------------------------------------------------

  const hostIs = (hostname, domain) => hostname === domain || hostname.endsWith('.' + domain);

  const LINK_PATTERNS = {
    [LINK.VNDB]: { host: 'vndb.org', re: /^\/(v\d+)(?:[/?#.]|$)/i },
    [LINK.ANILIST]: { host: 'anilist.co', re: /^\/(anime|manga)\/(\d+)/i },
    [LINK.MAL]: { host: 'myanimelist.net', re: /^\/(anime|manga)\/(\d+)/i },
    [LINK.TMDB]: { host: 'themoviedb.org', re: /^\/(movie|tv)\/(\d+)/i },
    [LINK.IMDB]: { host: 'imdb.com', re: /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?title\/(tt\d+)/i },
    [LINK.IGDB]: { host: 'igdb.com', re: /^\/games\/([^/?#]+)/i },
    [LINK.SYOSETU]: { host: 'syosetu.com', re: /^\/(n\d{4}[a-z]{1,2})(?:[/?#]|$)/i },
    [LINK.BOOKMETER]: { host: 'bookmeter.com', re: /^\/books\/(\d+)/i },
    [LINK.AMAZON]: { host: 'amazon.co.jp', re: /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i },
  };

  function parseLinkKey(linkType, raw) {
    const p = LINK_PATTERNS[linkType];
    if (!p) return null;
    let u;
    try { u = raw instanceof URL ? raw : new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { return null; }
    if (!hostIs(u.hostname.toLowerCase(), p.host)) return null;
    const m = p.re.exec(u.pathname);
    if (!m) return null;
    return m.length > 2
      ? { linkType, kind: m[1].toLowerCase(), id: m[2] }
      : { linkType, kind: null, id: m[1].toLowerCase() };
  }

  const sameKey = (a, b) => a.linkType === b.linkType && String(a.id).toLowerCase() === String(b.id).toLowerCase()
    && (!a.kind || !b.kind || a.kind === b.kind);

  // by-link-id matches on the URL's last segment only, so MAL anime 1 and manga 1 (or TMDB
  // movie 1 and tv 1) both come back. A deck is dropped only when every link of that type
  // points somewhere else; a link the parser can't read keeps the deck, to never hide a match.
  function deckHasLink(deck, ref) {
    const links = (deck.links || []).filter((l) => l.linkType === ref.linkType);
    if (!links.length) return true;
    return links.some((l) => { const k = parseLinkKey(ref.linkType, l.url); return !k || sameKey(k, ref); });
  }

  // ---------------------------------------------------------------------------
  // Media type rules per site
  // ---------------------------------------------------------------------------

  function anilistJapaneseTitle(m) {
    const native = m.title?.native;
    if (m.countryOfOrigin === 'JP' || !m.countryOfOrigin) return hasJapanese(native) ? native : null;
    if (hasKana(native)) return native;
    return (m.synonyms || []).find(hasKana) || null;
  }

  const anilistMediaType = (m) => (m.type === 'ANIME' ? MT.ANIME : m.format === 'NOVEL' ? MT.NOVEL : MT.MANGA);

  function malMediaType(kind, typeText) {
    if (kind === 'anime') return MT.ANIME;
    return /novel/i.test(typeText || '') ? MT.NOVEL : MT.MANGA;
  }

  function screenMediaType({ kind, animation, game }) {
    if (game) return MT.VIDEOGAME;
    if (animation) return MT.ANIME;
    return kind === 'tv' ? MT.DRAMA : MT.MOVIE;
  }

  // ---------------------------------------------------------------------------
  // Sites: which page is which work, and what the page says about it
  // ---------------------------------------------------------------------------

  const $ = (doc, sel) => doc.querySelector(sel);
  const $$ = (doc, sel) => [...doc.querySelectorAll(sel)];
  const textOf = (doc, sel) => clean($(doc, sel)?.textContent);
  const rawOgTitle = (doc) => clean($(doc, 'meta[property="og:title"]')?.getAttribute('content'));
  const ogTitle = (doc) => cleanPageTitle(rawOgTitle(doc));

  const SITE_SUFFIX = /\s*[|·•\-–—]\s*(?:vndb|AniList|MyAnimeList\.net|IMDb|IGDB(?:\.com)?|Letterboxd|The Movie Database \(TMDb\)|読書メーター|小説家になろう)\s*$/i;
  function cleanPageTitle(t) {
    let s = clean(String(t || '').replace(/[\u200e\u200f]/g, ''));
    s = s.replace(/\s+directed by\s.*$/i, '').replace(/\s+•\s.*$/, '');
    for (let prev = ''; prev !== s;) {
      prev = s;
      s = s.replace(SITE_SUFFIX, '')
        .replace(/\s*\|\s*(?:Manga|Light Novel|Novel|Manhwa|Manhua|One-shot|Doujinshi|Anime)\s*$/i, '')
        .replace(/\s*\((?:TV Series|TV Mini Series|TV Movie|Video Game|Video|TV|Movie|OVA|ONA|Special|Music)?\s*(?:19|20)\d{2}[^)]*\)\s*$/i, '')
        .trim();
    }
    return s;
  }

  function imdbRefIn(doc) {
    for (const a of $$(doc, 'a[href*="imdb.com/"]')) {
      const k = parseLinkKey(LINK.IMDB, a.href);
      if (k) return { ...k, url: `https://www.imdb.com/title/${k.id}/` };
    }
    return null;
  }

  function bookmeterTitle(og, heading) {
    const quoted = /[『｢]([^』｣]+)[』｣]/.exec(og || '')?.[1];
    if (quoted) return clean(quoted);
    let t = clean(heading || String(og || '').split(/\s*[|｜]\s*/)[0]);
    while (/\s*[（(][^（()）]*[）)]$/.test(t)) t = t.replace(/\s*[（(][^（()）]*[）)]$/, '');
    return t;
  }

  function seriesTitle(title) {
    const m = /^(.+?)\s*(?:第?[0-9０-９]+巻?|[上中下]巻?)(?:\s.*)?$/.exec(clean(title));
    return m && clean(m[1]).length >= 2 ? clean(m[1]) : null;
  }

  const SITES = [
    {
      id: 'vndb',
      types: [MT.VN],
      name: 'VNDB',
      radius: 0,
      hosts: ['vndb.org'],
      palette(doc) {
        const art = $(doc, 'article');
        if (!art) return null;
        const cs = getComputedStyle(art);
        const pageBg = backgroundAt(doc.body) || [0, 0, 0];
        const link = $(doc, '.vndetails a') || $(doc, 'article p a') || $(doc, 'article a');
        return {
          bg: blendOver(cs.backgroundColor, pageBg), line: cs.borderTopColor, fg: cs.color,
          muted: withAlpha(cs.color, 0.7), accent: link ? getComputedStyle(link).color : null,
        };
      },
      match(u) {
        const m = /^\/(v\d+)\/?$/.exec(u.pathname);
        return m && { linkType: LINK.VNDB, kind: null, id: m[1], url: `https://vndb.org/${m[1]}` };
      },
      collect(ref, doc) {
        const main = textOf(doc, 'article h1') || ogTitle(doc);
        const jaRow = $$(doc, 'tr.title').find((tr) => tr.querySelector('abbr.icon-lang-ja'));
        const jp = clean(jaRow?.querySelector('span[lang="ja"]')?.textContent) || null;
        return { mediaType: MT.VN, titles: { jp, main } };
      },
      mount(doc) {
        const table = $(doc, '.vndetails table') || $(doc, 'article table.stripe');
        const rows = table ? $$(table, 'tr') : [];
        if (!rows.length) return null;
        const label = (tr) => clean(tr.querySelector('td')?.textContent);
        const after = rows.find((tr) => label(tr) === 'Play time') || rows[rows.length - 1];
        return { mode: 'rows', after };
      },
    },
    {
      id: 'anilist',
      types: [MT.ANIME, MT.MANGA, MT.NOVEL],
      name: 'AniList',
      radius: 3,
      hosts: ['anilist.co'],
      palette(doc) {
        const cs = getComputedStyle(doc.body);
        const v = (name) => cs.getPropertyValue(name).trim();
        if (!v('--color-foreground')) return null;
        return {
          bg: `rgb(${v('--color-foreground')})`, fg: `rgb(${v('--color-text')})`, muted: `rgb(${v('--color-text-lighter')})`,
          line: 'transparent', accent: `rgb(${v('--color-blue')})`,
        };
      },
      match(u) {
        const k = parseLinkKey(LINK.ANILIST, u);
        return k && { ...k, url: `https://anilist.co/${k.kind}/${k.id}` };
      },
      async collect(ref) {
        const m = await anilistMedia('id', ref.id, ref.kind);
        if (!m) throw new Error('AniList has no such entry.');
        return {
          mediaType: anilistMediaType(m),
          titles: { jp: anilistJapaneseTitle(m), main: m.title?.romaji, romaji: m.title?.romaji, english: m.title?.english },
          extraRefs: m.idMal ? [{ linkType: LINK.MAL, kind: ref.kind, id: String(m.idMal), url: `https://myanimelist.net/${ref.kind}/${m.idMal}` }] : [],
        };
      },
      mount: (doc) => panelAt(doc, [['.sidebar > .rankings', 'after'], ['.media-page-unscoped .sidebar', 'prepend'], ['.sidebar', 'prepend']]),
    },
    {
      id: 'mal',
      types: [MT.ANIME, MT.MANGA, MT.NOVEL],
      name: 'MyAnimeList',
      radius: 0,
      hosts: ['myanimelist.net'],
      match(u) {
        const k = parseLinkKey(LINK.MAL, u);
        return k && { ...k, url: `https://myanimelist.net/${k.kind}/${k.id}` };
      },
      async collect(ref, doc) {
        const side = {};
        for (const div of $$(doc, '.leftside .spaceit_pad')) {
          const m = /^([^:]+):\s*(.*)$/.exec(clean(div.textContent));
          if (m) side[m[1].toLowerCase()] ||= m[2];
        }
        const main = textOf(doc, 'h1.title-name') || textOf(doc, '.h1-title') || ogTitle(doc);
        const info = {
          mediaType: malMediaType(ref.kind, side.type),
          titles: { jp: hasJapanese(side.japanese) ? side.japanese : null, main, english: side.english || null },
          extraRefs: [],
        };
        try {
          const m = await anilistMedia('idMal', ref.id, ref.kind);
          if (m) {
            info.titles.jp = anilistJapaneseTitle(m) || info.titles.jp;
            info.titles.romaji = m.title?.romaji || null;
            info.titles.english ||= m.title?.english || null;
            info.extraRefs.push({ linkType: LINK.ANILIST, kind: ref.kind, id: String(m.id), url: `https://anilist.co/${ref.kind}/${m.id}` });
          }
        } catch { /* the MAL page alone is enough */ }
        return info;
      },
      native(doc) {
        const head = $(doc, '.leftside h2');
        const line = $(doc, '.leftside .spaceit_pad');
        if (!head || !line) return null;
        const pick = (n, props) => { const cs = getComputedStyle(n); return Object.fromEntries(props.map((k) => [k, cs.getPropertyValue(k)])); };
        const a = $(doc, '.leftside .spaceit_pad a');
        return {
          head: pick(head, ['font-family', 'font-size', 'font-weight', 'line-height', 'color', 'border-bottom', 'padding-bottom', 'margin-bottom']),
          body: pick(line, ['font-family', 'font-size', 'line-height', 'color']),
          link: a ? getComputedStyle(a).color : null,
        };
      },
      mount: (doc) => panelAt(doc, [['.leftside > .js-sns-icon-container', 'before'], ['.leftside > #profileRows', 'after'],
        ['.leftside > :first-child', 'after'], ['.leftside', 'prepend']]),
    },
    {
      id: 'tmdb',
      types: [MT.MOVIE, MT.DRAMA, MT.ANIME],
      name: 'TMDB',
      hosts: ['www.themoviedb.org'],
      native(doc) {
        const strong = $(doc, 'section.facts p strong');
        const value = $(doc, 'section.facts p');
        if (!strong || !value) return null;
        const pick = (n, props) => { const cs = getComputedStyle(n); return Object.fromEntries(props.map((k) => [k, cs.getPropertyValue(k)])); };
        const h = $(doc, 'section.keywords h4') || $(doc, '.grey_column h4');
        const a = $(doc, 'section.facts p a') || $(doc, '.content_wrapper a');
        return {
          layout: 'facts',
          head: { ...(h ? pick(h, ['font-family', 'font-size', 'font-weight', 'color']) : {}), 'margin-bottom': '10px' },
          body: pick(value, ['font-family', 'font-size', 'line-height', 'color']),
          label: pick(strong, ['font-weight']),
          link: a ? getComputedStyle(a).color : null,
        };
      },
      match(u) {
        if (!/^\/(movie|tv)\/\d+[^/]*\/?$/.test(u.pathname)) return null;
        const k = parseLinkKey(LINK.TMDB, u);
        return k && { ...k, url: `https://www.themoviedb.org/${k.kind}/${k.id}` };
      },
      collect(ref, doc) {
        const title = textOf(doc, 'section.header .title h2 a') || textOf(doc, '.title h2 a') || ogTitle(doc);
        let original = null;
        for (const p of $$(doc, 'section.facts p, .facts p')) {
          const strong = clean(p.querySelector('strong')?.textContent);
          if (!strong) continue;
          const value = clean(p.textContent).slice(strong.length).trim();
          if (/original (title|name)|原題/i.test(strong)) original = value;
        }
        const genres = $$(doc, '.facts .genres a, span.genres a').map((a) => clean(a.textContent));
        const animation = genres.some((g) => /animation|アニメ/i.test(g));
        const imdb = imdbRefIn(doc);
        return {
          mediaType: screenMediaType({ kind: ref.kind, animation }),
          titles: { jp: hasJapanese(original) ? original : hasJapanese(title) ? title : null, main: original || title, english: title },
          extraRefs: imdb ? [imdb] : [],
        };
      },
      mount: (doc) => panelAt(doc, [['section.facts', 'before'], ['.facts', 'before']]),
    },
    {
      id: 'letterboxd',
      types: [MT.MOVIE, MT.DRAMA, MT.ANIME],
      name: 'Letterboxd',
      radius: 4,
      hosts: ['letterboxd.com'],
      palette: () => ({ bg: 'rgb(20,24,28)', line: 'rgb(44,52,64)', fg: 'rgb(221,238,255)', muted: 'rgb(153,170,187)', accent: 'rgb(64,188,244)' }),
      match(u, doc) {
        if (!/^\/film\/[^/]+\/?$/.test(u.pathname) || !doc?.body) return null;
        let kind = doc.body.dataset?.tmdbType || 'movie';
        let id = doc.body.dataset?.tmdbId;
        if (!id) {
          const a = $(doc, 'a[data-track-action="TMDB"], a[href*="themoviedb.org/movie/"], a[href*="themoviedb.org/tv/"]');
          const k = a && parseLinkKey(LINK.TMDB, a.href);
          if (!k) return null;
          ({ kind, id } = k);
        }
        return { linkType: LINK.TMDB, kind, id: String(id), url: `https://www.themoviedb.org/${kind}/${id}` };
      },
      collect(ref, doc) {
        const title = textOf(doc, 'h1.headline-1 .name') || textOf(doc, 'h1.primaryname') || textOf(doc, '.film-header h1')
          || ogTitle(doc);
        const original = clean(($(doc, '.originalname') || $(doc, '[class*="originalname"]'))?.textContent).replace(/^[‘'"]|[’'"]$/g, '') || null;
        const animation = !!$(doc, 'a[href*="/films/genre/animation/"]');
        const imdb = imdbRefIn(doc);
        return {
          mediaType: screenMediaType({ kind: ref.kind, animation }),
          titles: { jp: hasJapanese(original) ? original : null, main: original || title, english: title },
          extraRefs: imdb ? [imdb] : [],
        };
      },
      mount: (doc) => panelAt(doc, [['aside.sidebar .ratings-histogram-chart', 'after'], ['aside.sidebar', 'append']]),
    },
    {
      id: 'imdb',
      types: [MT.MOVIE, MT.DRAMA, MT.ANIME, MT.VIDEOGAME],
      name: 'IMDb',
      radius: 12,
      hosts: ['www.imdb.com'],
      dark: true,
      glass: true,
      palette: () => ({ bg: 'rgba(31,31,31,0.8)', fg: 'rgb(255,255,255)', muted: 'rgba(255,255,255,0.7)',
        line: 'rgba(255,255,255,0.14)', accent: 'rgb(87,153,239)' }),
      match(u) {
        if (!/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?title\/tt\d+\/?$/i.test(u.pathname)) return null;
        const k = parseLinkKey(LINK.IMDB, u);
        return k && { ...k, url: `https://www.imdb.com/title/${k.id}/` };
      },
      collect(ref, doc) {
        let ld = {};
        try { ld = JSON.parse($(doc, 'script[type="application/ld+json"]')?.textContent || '{}'); } catch { /* ignore */ }
        const type = String(ld['@type'] || '');
        const genres = [].concat(ld.genre || []);
        const title = textOf(doc, '[data-testid="hero__pageTitle"]') || clean(ld.name) || ogTitle(doc);
        const originalLine = $$(doc, '[data-testid="hero__pageTitle"] ~ div, [data-testid="hero__pageTitle"] + *')
          .map((n) => clean(n.textContent)).find((t) => /^original title:/i.test(t));
        const original = originalLine ? originalLine.replace(/^original title:\s*/i, '') : null;
        return {
          mediaType: screenMediaType({
            kind: /TVSeries|TVMiniSeries/i.test(type) ? 'tv' : 'movie',
            animation: genres.some((g) => /animation/i.test(g)), game: /VideoGame/i.test(type),
          }),
          titles: hasJapanese(original) ? { jp: original, main: original, english: title } : { main: title, romaji: original, english: title },
        };
      },
      cornerOnly: true,
      mount: () => null,
    },
    {
      id: 'igdb',
      types: [MT.VIDEOGAME, MT.VN],
      name: 'IGDB',
      radius: 0,
      dark: true,
      edge: 'rgb(145,71,255)',
      palette: () => ({ bg: 'rgb(58,61,71)', line: 'rgb(84,87,99)', fg: 'rgb(239,239,241)', muted: 'rgb(173,173,184)',
        accent: 'rgb(191,148,255)' }),
      hosts: ['www.igdb.com'],
      match(u) {
        if (!/^\/games\/[^/?#]+\/?$/.test(u.pathname)) return null;
        const k = parseLinkKey(LINK.IGDB, u);
        return k && { ...k, url: `https://www.igdb.com/games/${k.id}` };
      },
      async collect(ref, doc) {
        for (let i = 0; i < 30 && !textOf(doc, 'h1'); i++) await sleep(100);
        const main = cleanPageTitle(textOf(doc, 'h1') || rawOgTitle(doc) || doc.title);
        const vn = !!$(doc, 'a[href*="/genres/visual-novel"]');
        return { mediaType: vn ? MT.VN : MT.VIDEOGAME, titles: { main } };
      },
      cornerOnly: true,
      mount: () => null,
    },
    {
      id: 'syosetu',
      types: [MT.WEBNOVEL],
      name: 'Syosetu',
      wide: true,
      flat: true,
      hosts: ['ncode.syosetu.com'],
      palette(doc) {
        const link = $(doc, '.p-novel__author a') || $(doc, '.p-eplist__subtitle') || $(doc, '.novel_writername a') || $(doc, '.subtitle a');
        return link ? { accent: getComputedStyle(link).color } : null;
      },
      match(u) {
        const m = /^\/(n\d{4}[a-z]{1,2})\/?$/i.exec(u.pathname);
        return m && { linkType: LINK.SYOSETU, kind: null, id: m[1].toLowerCase(), url: `https://${u.hostname}/${m[1].toLowerCase()}/` };
      },
      collect(ref, doc) {
        const main = textOf(doc, '.p-novel__title') || textOf(doc, '.novel_title') || clean(doc.title);
        return { mediaType: MT.WEBNOVEL, titles: { jp: main, main } };
      },
      mount: (doc) => panelAt(doc, [['.p-novel__title', 'after'], ['.novel_title', 'after']]),
    },
    {
      id: 'bookmeter',
      types: [MT.NOVEL, MT.NONFICTION, MT.MANGA],
      name: 'Bookmeter',
      radius: 6,
      band: 'rgb(242,242,242)',
      palette: () => ({ line: 'rgb(221,221,221)', fg: 'rgb(51,51,51)' }),
      hosts: ['bookmeter.com'],
      match(u) {
        const m = /^\/books\/(\d+)\/?$/.exec(u.pathname);
        return m && { linkType: LINK.BOOKMETER, kind: null, id: m[1], url: `https://bookmeter.com/books/${m[1]}` };
      },
      collect(ref, doc) {
        const main = bookmeterTitle(rawOgTitle(doc), textOf(doc, '.inner__title') || textOf(doc, 'h1'));
        const amazon = $$(doc, 'a[href*="amazon.co.jp"]').map((a) => parseLinkKey(LINK.AMAZON, a.href)).find(Boolean);
        return {
          mediaType: null,
          titles: { jp: hasJapanese(main) ? main : null, main, series: seriesTitle(main) },
          extraRefs: amazon ? [{ ...amazon, url: `https://www.amazon.co.jp/dp/${amazon.id.toUpperCase()}` }] : [],
        };
      },
      mount: (doc) => betweenTexts(doc, '本の詳細', '書店で詳細を見る')
        || panelAt(doc, [['.inner__title', 'after'], ['.header__title', 'after'], ['h1', 'after']]),
    },
  ];

  function matchPage(u, doc) {
    for (const site of SITES) {
      if (!site.hosts.some((h) => hostIs(u.hostname, h))) continue;
      const ref = site.match(u, doc);
      if (ref) return { site, ref };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Settings and storage (userscript APIs, with plain browser fallbacks)
  // ---------------------------------------------------------------------------

  // Tampermonkey and Violentmonkey have the GM_* functions; Greasemonkey 4 only has the promise-based GM.* ones.
  const GM4 = typeof GM === 'object' && GM ? GM : null;
  const scriptVersion = (typeof GM_info === 'object' && GM_info?.script?.version) || GM4?.info?.script?.version || null;
  const CLIENT_NAME = scriptVersion ? `Jiten Everywhere/${scriptVersion}` : 'Jiten Everywhere';
  const gmXhr = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
    : GM4?.xmlHttpRequest ? (details) => GM4.xmlHttpRequest(details) : null;
  const gmMenu = typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand
    : GM4?.registerMenuCommand ? (name, fn) => GM4.registerMenuCommand(name, fn) : null;

  const LS_PREFIX = 'jiten-everywhere:';
  const store = {
    async get(key) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(key);
        if (GM4?.getValue) return await GM4.getValue(key);
        const v = localStorage.getItem(LS_PREFIX + key);
        return v === null ? undefined : JSON.parse(v);
      } catch { return undefined; }
    },
    async set(key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, value);
        else if (GM4?.setValue) await GM4.setValue(key, value);
        else localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
      } catch { /* ignore */ }
    },
    async delete(key) {
      try {
        if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
        else if (GM4?.deleteValue) await GM4.deleteValue(key);
        else localStorage.removeItem(LS_PREFIX + key);
      } catch { /* ignore */ }
    },
  };

  const SETTING_FIELDS = [
    { key: 'apiKey', label: 'Key', type: 'password', def: '' },
    { key: 'titleLanguage', label: 'Jiten titles in', type: 'choice', def: 'japanese',
      options: [['japanese', 'Japanese'], ['romaji', 'Romaji'], ['english', 'English']] },
    { key: 'readingSpeed', label: 'Reading speed (characters per hour)', type: 'number', def: 14000 },
    { key: 'showStatus', label: 'Jiten status and favourite (needs API key)', type: 'checkbox', stat: true, def: true },
    { key: 'showProgress', label: 'Your progress (needs API key)', type: 'checkbox', stat: true, def: true },
    { key: 'showCharacters', label: 'Character count', type: 'checkbox', stat: true, def: true },
    { key: 'showCoverage', label: 'Coverage (needs API key)', type: 'checkbox', stat: true, def: true },
    { key: 'showUniqueCoverage', label: 'Unique coverage (needs API key)', type: 'checkbox', stat: true, def: true },
    { key: 'showUnknownWords', label: 'Unknown words (needs API key)', type: 'checkbox', stat: true, def: true },
    { key: 'showSentenceCoverage', label: 'Sentence coverage (needs API key and Jiten+)', type: 'checkbox', stat: true, def: false },
    { key: 'showReadingTime', label: 'Reading time estimate', type: 'checkbox', stat: true, def: true },
    { key: 'showSpeech', label: 'Speech duration (anime, dramas, movies)', type: 'checkbox', stat: true, def: true },
    { key: 'showSpeechSpeed', label: 'Speech speed (anime, dramas, movies)', type: 'checkbox', stat: true, def: false },
    { key: 'showDifficulty', label: 'Difficulty', type: 'checkbox', stat: true, def: true },
    { key: 'showUniqueWords', label: 'Unique words', type: 'checkbox', stat: true, def: true },
    { key: 'showUniqueKanji', label: 'Unique kanji', type: 'checkbox', stat: true, def: true },
    { key: 'showWordCount', label: 'Word count', type: 'checkbox', stat: true, def: false },
    { key: 'showSentenceLength', label: 'Average sentence length', type: 'checkbox', stat: true, def: false },
    { key: 'showDialogue', label: 'Dialogue percentage (novels, visual novels, web novels, non-fiction)', type: 'checkbox', stat: true, def: false },
    { key: 'showChildren', label: 'Episodes / volumes (anime, dramas, novels, manga)', type: 'checkbox', stat: true, def: true },
    { key: 'statOrder', type: 'hidden', def: null },
    { key: 'coverageBars', label: 'Coverage bars', type: 'checkbox', def: true },
    { key: 'showRequestButton', label: '"Request on Jiten" link', type: 'checkbox', def: true },
    ...SITES.map((site) => ({
      key: `placement_${site.id}`, label: site.name, type: 'choice', site: site.id, def: site.cornerOnly ? 'corner' : 'inline',
      options: [['off', 'Off'], ...(site.cornerOnly ? [] : [['inline', 'In page']]), ['corner', 'Bottom right']],
    })),
  ];
  const placementOf = (site) => settings.get(`placement_${site.id}`);
  const STAT_KEYS = SETTING_FIELDS.filter((f) => f.stat).map((f) => f.key);

  function statOrder(saved) {
    const order = (Array.isArray(saved) ? saved : []).filter((k) => STAT_KEYS.includes(k));
    STAT_KEYS.forEach((k, i) => {
      if (order.includes(k)) return;
      const after = STAT_KEYS.slice(0, i).reverse().find((p) => order.includes(p));
      order.splice(after ? order.indexOf(after) + 1 : 0, 0, k);
    });
    return order;
  }
  const DEFAULTS = Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, f.def]));
  const SITE_DEFAULTS = {
    vndb: { showSpeech: false, showDifficulty: false, showUniqueWords: false, showUniqueKanji: false, showChildren: false },
  };
  const siteDefaults = (siteId) => ({ ...DEFAULTS, ...(SITE_DEFAULTS[siteId] || {}) });

  const settingValues = {};
  let defaultsHere = DEFAULTS;
  const settingsReady = (async () => {
    for (const f of SETTING_FIELDS) {
      const v = await store.get('setting:' + f.key);
      if (v !== undefined) settingValues[f.key] = v;
    }
  })();
  const settings = {
    get: (key) => (key in settingValues ? settingValues[key] : defaultsHere[key]),
    all: () => ({ ...defaultsHere, ...settingValues }),
    async set(key, value) { settingValues[key] = value; await store.set('setting:' + key, value); },
    preview(key, value) { settingValues[key] = value; },
  };

  function localDate(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ---------------------------------------------------------------------------
  // HTTP: throttled per host, one retry on 429
  // ---------------------------------------------------------------------------

  const HOSTS = {
    'api.jiten.moe': { name: 'Jiten', gap: 120 },
    'graphql.anilist.co': { name: 'AniList', gap: 700 },
  };
  const MAX_RETRY_WAIT = 10000;
  const hostState = {};

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function httpError(message, status) {
    const e = new Error(message);
    e.status = status;
    return e;
  }

  function rateLimitError(host, until) {
    const secs = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    const e = httpError(`${HOSTS[host]?.name || host} is rate-limiting, try again in ${secs}s.`, 429);
    e.retryAt = until;
    return e;
  }

  async function throttle(host) {
    const st = hostState[host] ||= { next: 0, pausedUntil: 0 };
    if (st.pausedUntil > Date.now()) throw rateLimitError(host, st.pausedUntil);
    const start = Math.max(Date.now(), st.next);
    st.next = start + (HOSTS[host]?.gap || 0);
    if (start > Date.now()) await sleep(start - Date.now());
  }

  function retryAfterMs(value) {
    if (!value) return 5000;
    const secs = Number(value);
    if (!Number.isNaN(secs)) return secs * 1000;
    const date = Date.parse(value);
    return Number.isNaN(date) ? 5000 : Math.max(0, date - Date.now());
  }

  function send({ method, url, headers, body }) {
    return new Promise((resolve, reject) => {
      const name = HOSTS[new URL(url).host]?.name || new URL(url).host;
      if (gmXhr) {
        gmXhr({
          method, url, headers, data: body, timeout: 15000,
          anonymous: true,
          onload: (r) => resolve({
            status: r.status, text: r.responseText,
            retryAfter: /^retry-after:\s*(.+)$/im.exec(r.responseHeaders || '')?.[1]?.trim(),
          }),
          onerror: () => reject(new Error(`Couldn't reach ${name}.`)),
          ontimeout: () => reject(new Error(`${name} took too long to answer.`)),
        });
      } else {
        fetch(url, { method, headers, body, credentials: 'omit' })
          .then(async (r) => resolve({ status: r.status, text: await r.text(), retryAfter: r.headers.get('retry-after') }))
          .catch(() => reject(new Error(`Couldn't reach ${name}.`)));
      }
    });
  }

  async function request({ method = 'GET', url, headers = {}, body }) {
    const host = new URL(url).host;
    const name = HOSTS[host]?.name || host;
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      await throttle(host);
      res = await send({ method, url, headers, body });
      if (res.status !== 429) break;
      const wait = retryAfterMs(res.retryAfter);
      if (attempt === 1 || wait > MAX_RETRY_WAIT) {
        const st = hostState[host];
        st.pausedUntil = Date.now() + Math.max(wait, 5000);
        throw rateLimitError(host, st.pausedUntil);
      }
      await sleep(wait);
    }
    if (res.status < 200 || res.status >= 300) throw httpError(`${name} returned an error (${res.status}).`, res.status);
    try { return JSON.parse(res.text); } catch { throw new Error(`${name} sent an unreadable answer.`); }
  }

  async function anilistMedia(by, id, kind) {
    const q = `query($id:Int,$type:MediaType){Media(${by}:$id,type:$type){id idMal type format countryOfOrigin synonyms title{native romaji english}}}`;
    try {
      const r = await request({
        method: 'POST', url: 'https://graphql.anilist.co',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: q, variables: { id: Number(id), type: kind.toUpperCase() } }),
      });
      return r?.data?.Media || null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Jiten API
  // ---------------------------------------------------------------------------

  const jitenApi = {
    get hasKey() { return !!clean(settings.get('apiKey')); },
    headers() {
      const key = clean(settings.get('apiKey'));
      const base = { Accept: 'application/json', 'X-Client-Name': CLIENT_NAME };
      return key ? { ...base, 'X-Api-Key': key } : base;
    },
    get(path) { return request({ url: JITEN_API + path, headers: this.headers() }); },
    post(path, payload) {
      return request({ method: 'POST', url: JITEN_API + path, headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    },
    setStatus(deckId, status) {
      return this.post(`/user/deck-preferences/${deckId}/status`, {
        status, date: localDate(), dateUnknown: false, newEntry: false, undoCompletion: false,
      });
    },
    setFavourite(deckId, isFavourite) { return this.post(`/user/deck-preferences/${deckId}/favourite`, { isFavourite }); },
    restore(previous) { return this.post('/user/media-list/restore', { decks: previous }); },

    async byLinkId(ref) {
      const r = await this.get(`/media-deck/by-link-id/${ref.linkType}/${encodeURIComponent(String(ref.id).toLowerCase())}`);
      return Array.isArray(r) ? r : [];
    },
    async detail(deckId) {
      const r = await this.get(`/media-deck/${deckId}/detail?limit=0`);
      return r?.data?.mainDeck ? { mainDeck: r.data.mainDeck, parentDeck: r.data.parentDeck || null } : null;
    },
    async suggestions(query) {
      const r = await this.get(`/media-deck/search-suggestions?limit=8&query=${encodeURIComponent(query)}`);
      return r?.suggestions || [];
    },
    async sentenceMetrics(deck) {
      let r;
      try { r = await this.get(`/media-deck/${deck.deckId}/sentence-summary`); } catch (e) {
        if ([401, 403, 404].includes(e.status)) return null;
        throw e;
      }
      if (!r?.hasData || !(r.total > 0)) return null;
      const pct = (n) => (100 * n) / r.total;
      return {
        readableSentences: pct(r.readable), iPlusOneSentences: pct(r.oneUnknown), iPlusTwoSentences: pct(r.twoUnknown),
        iPlusThreeSentences: pct(r.threeOrMoreUnknown),
      };
    },
    duplicateCheck({ title, url, mediaType }) {
      const q = new URLSearchParams();
      if (title) q.set('title', title);
      if (url) q.set('externalUrl', url);
      if (mediaType) q.set('mediaType', mediaType);
      return this.get(`/requests/duplicate-check?${q}`);
    },
  };

  // ---------------------------------------------------------------------------
  // The check: is this work on Jiten, or already requested?
  // ---------------------------------------------------------------------------

  function mainTitlePart(title) {
    const t = clean(title);
    const m = /^(.+?)\s*(?:[:：]|\s[-–—]\s|[~〜～])/.exec(t);
    if (!m) return null;
    const base = clean(m[1]);
    return base !== t && base.length >= (hasJapanese(base) ? 2 : 4) ? base : null;
  }

  const titleVariants = (t) => [...new Set([t.jp, t.main, t.series, t.romaji, t.english].map(clean).filter((s) => s.length >= 2))];

  // Never concludes "not on Jiten" from links alone: titles are always searched too, and
  // with an API key Jiten's own duplicate check (decks and open requests) runs as well.
  // Any failure throws, so the caller shows an error rather than a request button.
  async function checkJiten({ refs, info }, api) {
    const linked = await Promise.all(refs.map(async (ref) => (await api.byLinkId(ref)).slice(0, 8).map((id) => ({ id, ref }))));
    const seen = new Set();
    const candidates = linked.flat().filter(({ id }) => !seen.has(id) && seen.add(id));
    const decks = new Map();
    for (const { detail, ref } of await Promise.all(candidates.map(async (c) => ({ ...c, detail: await api.detail(c.id) })))) {
      if (!detail || !deckHasLink(detail.mainDeck, ref)) continue;
      const deck = detail.mainDeck.parentDeckId && detail.parentDeck
        ? ((await api.detail(detail.parentDeck.deckId))?.mainDeck || detail.parentDeck) : detail.mainDeck;
      decks.set(deck.deckId, deck);
    }
    if (decks.size) return { state: 'found', decks: [...decks.values()] };

    const variants = titleVariants(info.titles || {});
    const matches = new Map();
    // Jiten's search is fuzzy: a romanized or English query brings back titles that only share a
    // fragment of it. Search-only hits are kept for Japanese queries alone, where they're usually
    // the same work under an alias (a katakana title for one Jiten stores in Latin letters).
    const addMatch = (deck, strength, query) => {
      if (strength === 0 && !hasJapanese(query)) return;
      const prev = matches.get(deck.deckId);
      if (!prev || prev.strength < strength) matches.set(deck.deckId, { deck, strength });
    };

    const urls = refs.map((r) => r.url).filter(Boolean);
    const dupCalls = api.hasKey ? Math.max(1, Math.min(3, Math.max(urls.length, variants.length))) : 0;
    const dupChecks = Promise.all([...Array(dupCalls).keys()].map((i) =>
      api.duplicateCheck({ title: variants[i] || variants[0], url: urls[i] || urls[0], mediaType: info.mediaType })));
    const searches = Promise.all(variants.slice(0, 3).map((q) => api.suggestions(q)));
    // The main title alone, for other versions under another subtitle. Its hits are only ever
    // "similar titles": never shown as this work, since a series name also finds sequels.
    const bases = [...new Set(variants.slice(0, 3).map(mainTitlePart).filter((b) => b && !variants.includes(b)))].slice(0, 2);
    const baseSearches = Promise.all(bases.map((q) => api.suggestions(q)));

    let authoritative = false;
    let keyRejected = false;
    const requests = new Map();
    if (dupCalls) {
      baseSearches.catch(() => {});
      try {
        for (const [i, r] of (await dupChecks).entries()) {
          for (const d of (r?.existingDecks || []).filter((x) => isCompatible(info, x.mediaType))) {
            addMatch({ ...d, originalTitle: d.title }, d.isExactMatch ? 3 : titleStrength(variants, d), variants[i] || variants[0]);
          }
          for (const q of r?.existingRequests || []) requests.set(q.id, q);
        }
        authoritative = true;
      } catch (e) {
        if (e.status !== 401 && e.status !== 403) { searches.catch(() => {}); throw e; }
        keyRejected = true;
      }
    }

    for (const [i, list] of (await searches).entries()) {
      for (const d of list) {
        if (isCompatible(info, d.mediaType)) addMatch(d, titleStrength(variants, d), variants[i]);
      }
    }
    for (const [i, list] of (await baseSearches).entries()) {
      for (const d of list) {
        if (isCompatible(info, d.mediaType) && titleStrength([bases[i]], d) >= 1) addMatch(d, 1, bases[i]);
      }
    }

    // Exactly one deck of the page's own media type with exactly this title is the work, just not
    // linked to this page on Jiten: show its stats. Two or more stay "possible matches".
    // A page whose type isn't known (Bookmeter) never gets this: a novel's page would show
    // its manga adaptation's stats when only the manga is on Jiten.
    const exact = [...matches.values()].filter((m) => m.strength >= 2 && info.mediaType && m.deck.mediaType === info.mediaType);
    if (exact.length === 1) {
      const detail = await api.detail(exact[0].deck.deckId);
      if (detail) {
        const deck = detail.mainDeck.parentDeckId && detail.parentDeck ? detail.parentDeck : detail.mainDeck;
        return { state: 'found', decks: [deck], byTitle: true, matches: [] };
      }
    }

    const all = [...requests.values()];
    const result = {
      state: 'none',
      authoritative, keyRejected,
      matches: [...matches.values()].sort((a, b) => b.strength - a.strength),
      requests: all.filter((q) => ACTIVE_REQUEST.includes(q.status)),
      closedRequests: all.filter((q) => !ACTIVE_REQUEST.includes(q.status)),
    };
    if (result.requests.length) result.state = 'requested';
    else if (result.matches.length) result.state = 'possible';
    return result;
  }

  function statRows(decks, s) {
    const rows = [];
    const add = (key, label, has, value, hint, bar) => {
      if (!s[key] || !decks.some(has)) return;
      const withBar = !!bar && s.coverageBars !== false && decks.length === 1;
      const row = { key, label, value: decks.map((d) => (has(d) ? value(d) : '–')).join(' / '),
        hint: Array.isArray(hint) ? (withBar ? hint.join(' ') : hint[0]) : hint };
      if (withBar) row.bar = bar(decks[0]);
      rows.push(row);
    };
    if (s.showStatus && clean(s.apiKey)) rows.push({ key: 'showStatus', label: 'Jiten status', value: '', status: true });
    add('showProgress', 'Progress', (d) => progressText(d) !== null, progressText, 'From your Jiten list: how far you are, and how many times you\'ve finished it');
    const speed = Number(s.readingSpeed) > 0 ? Number(s.readingSpeed) : 14000;
    const timed = (d) => TIMED_SPEECH.includes(d.mediaType) && d.speechDuration > 0;

    add('showCharacters', 'Characters', (d) => d.characterCount > 0, (d) => fmt(d.characterCount));
    add('showReadingTime', 'Reading time (est.)', (d) => READING.includes(d.mediaType) && d.characterCount > 0,
      (d) => formatTime(d.characterCount / speed), `At ${fmt(speed)} characters/hour. Change it in the settings.`);
    add('showSpeech', 'Speech duration', timed, (d) => formatSpeech(d.speechDuration), 'Total speech, silence excluded');
    add('showDifficulty', 'Difficulty', (d) => difficultyText(d) !== null, difficultyText);
    add('showWordCount', 'Words', (d) => d.wordCount > 0, (d) => fmt(d.wordCount));
    add('showUniqueWords', 'Unique words', (d) => d.uniqueWordCount > 0, (d) => fmt(d.uniqueWordCount));
    add('showUniqueKanji', 'Unique kanji', (d) => d.uniqueKanjiCount > 0, (d) => fmt(d.uniqueKanjiCount));
    add('showSentenceLength', 'Avg. sentence length', (d) => !d.hideAverageSentenceLength && d.averageSentenceLength > 0,
      (d) => d.averageSentenceLength.toFixed(1));
    add('showDialogue', 'Dialogue', (d) => READING.includes(d.mediaType) && !d.hideDialoguePercentage
      && d.dialoguePercentage > 0 && d.dialoguePercentage < 100,
      (d) => `${d.dialoguePercentage.toFixed(1)}%`);
    add('showSpeechSpeed', 'Speech speed', (d) => timed(d) && d.speechSpeed > 0, (d) => d.speechSpeed.toFixed(0), 'Mora per minute');
    const coverageTitle = (words, mature = 0, young = 0) => {
      const part = (pct) => (words ? `${((words * pct) / 100).toFixed(0)} / ${words} ` : '') + `(${pct.toFixed(1)}%)`;
      return `Mature: ${part(mature)}\nYoung: ${part(young)}\nTotal: ${Math.min(mature + young, 100).toFixed(1)}%`;
    };
    add('showCoverage', 'Coverage', (d) => (d.coverage || 0) + (d.youngCoverage || 0) > 0,
      (d) => `${(d.coverage || 0).toFixed(1)}%`, ['Words of this work you know', '(lighter bar: ones you\'re learning)'],
      (d) => ({ solid: d.coverage || 0, light: (d.coverage || 0) + (d.youngCoverage || 0), color: 'coverage',
        title: coverageTitle(d.wordCount, d.coverage, d.youngCoverage) }));
    add('showUniqueCoverage', 'Unique', (d) => (d.uniqueCoverage || 0) + (d.youngUniqueCoverage || 0) > 0,
      (d) => `${(d.uniqueCoverage || 0).toFixed(1)}%`, ['Distinct words of this work you know', '(lighter bar: ones you\'re learning)'],
      (d) => ({ solid: d.uniqueCoverage || 0, light: (d.uniqueCoverage || 0) + (d.youngUniqueCoverage || 0), color: 'coverage',
        title: coverageTitle(d.uniqueWordCount, d.uniqueCoverage, d.youngUniqueCoverage) }));
    add('showSentenceCoverage', 'Sentences', (d) => d.readableSentences != null, (d) => `${Math.floor(d.readableSentences)}%`,
      ['Sentences where you know every word', '(lighter bar: with at most one new word)'],
      (d) => ({ solid: d.readableSentences, light: d.readableSentences + (d.iPlusOneSentences || 0), color: 'sentences',
        title: `Sentences you understand\n${Math.floor(d.readableSentences)}% with every word known`
          + `\n${Math.floor(Math.min(d.readableSentences + (d.iPlusOneSentences || 0), 100))}% with at most one new word`
          + (d.iPlusOneSentences != null && d.iPlusTwoSentences != null && d.iPlusThreeSentences != null
            ? `\ni+1 ${Math.floor(d.iPlusOneSentences)}% · i+2 ${Math.floor(d.iPlusTwoSentences)}% · i+3+ ${Math.floor(d.iPlusThreeSentences)}%` : '') }));
    // From unique coverage.
    const knownUnique = (d) => (d.uniqueCoverage || 0) + (d.youngUniqueCoverage || 0);
    add('showUnknownWords', 'Unknown words', (d) => d.uniqueWordCount > 0 && knownUnique(d) > 0,
      (d) => fmt(Math.round((d.uniqueWordCount * Math.max(0, 100 - knownUnique(d))) / 100)),
      'Distinct words in this work you don\'t know yet (ones you\'re learning count as known)');
    if (childLabel(decks[0].mediaType)) {
      add('showChildren', childLabel(decks[0].mediaType), (d) => d.childrenDeckCount > 0 && childLabel(d.mediaType), (d) => fmt(d.childrenDeckCount));
    }
    const order = statOrder(s.statOrder);
    return rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }

  const TITLE_ORDER = {
    japanese: ['originalTitle', 'romajiTitle', 'englishTitle'],
    romaji: ['romajiTitle', 'originalTitle', 'englishTitle'],
    english: ['englishTitle', 'romajiTitle', 'originalTitle'],
  };
  function deckTitle(d, language = 'japanese') {
    const order = TITLE_ORDER[language] || TITLE_ORDER.japanese;
    return clean(order.map((k) => d[k]).find((t) => clean(t))) || `Deck ${d.deckId}`;
  }

  const requestTitle = (info) => clean(info.titles?.jp || info.titles?.main || info.titles?.english || info.titles?.romaji);

  // ---------------------------------------------------------------------------
  // Everything below needs a browser.
  // ---------------------------------------------------------------------------

  const exported = {
    LINK, MT, COMPATIBLE, SITES, localDate, parseLinkKey, sameKey, deckHasLink, matchPage, normalizeTitle, titleStrength,
    anilistJapaneseTitle, anilistMediaType, malMediaType, screenMediaType, formatTime, formatSpeech, difficultyText,
    statRows, checkJiten, requestTitle, titleVariants, mainTitlePart, DEFAULTS, siteDefaults, statOrder, STAT_KEYS, deckTitle, bookmeterTitle, seriesTitle, cleanPageTitle,
  };
  if (typeof module === 'object' && module && module.exports) {
    module.exports = exported;
    return;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) if (c != null && c !== false) n.append(c);
    return n;
  }

  const GEAR_PATH = (() => {
    const teeth = 8;
    const pts = [];
    for (let i = 0; i < teeth * 4; i++) {
      const a = (i / (teeth * 4)) * 2 * Math.PI - Math.PI / 2;
      const r = i % 4 < 2 ? 10.5 : 8;
      pts.push(`${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`);
    }
    return `M${pts.join('L')}Z M15.2 12a3.2 3.2 0 1 0-6.4 0a3.2 3.2 0 1 0 6.4 0Z`;
  })();
  function gearIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '0.95em');
    svg.setAttribute('height', '0.95em');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', GEAR_PATH);
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('fill-rule', 'evenodd');
    svg.append(path);
    return svg;
  }

  function gripIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 10 16');
    svg.setAttribute('width', '8');
    svg.setAttribute('height', '13');
    svg.setAttribute('aria-hidden', 'true');
    for (const [x, y] of [[2, 3], [8, 3], [2, 8], [8, 8], [2, 13], [8, 13]]) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', '1.5'); c.setAttribute('fill', 'currentColor');
      svg.append(c);
    }
    return svg;
  }

  const link = (href, text, title) => el('a', { href, target: '_blank', rel: 'noopener', title }, text);
  const deckUrl = (id) => `${JITEN}/decks/media/${id}/detail`;
  const deckName = (d) => deckTitle(d, settings.get('titleLanguage'));
  const otherTitles = (d) => [...new Set([d.originalTitle, d.romajiTitle, d.englishTitle].map(clean).filter(Boolean))]
    .filter((t) => t !== deckName(d)).join(' · ');
  const joinNodes = (nodes, sep = ' / ') => nodes.flatMap((n, i) => (i ? [sep, n] : [n]));

  function byText(doc, text) {
    let found = null;
    for (const n of doc.querySelectorAll('body *')) {
      if (n.closest('.jiten-everywhere') || clean(n.textContent) !== text) continue;
      found = n;
    }
    return found;
  }

  function betweenTexts(doc, above, below) {
    const a = byText(doc, above);
    const b = byText(doc, below);
    if (!a && !b) return null;
    if (a && b) {
      let block = a;
      while (block.parentElement && !block.parentElement.contains(b)) block = block.parentElement;
      if (block.parentElement && block !== a.ownerDocument.body) return { mode: 'panel', node: block, where: 'after' };
    }
    const lone = a || b;
    return { mode: 'panel', node: lone.parentElement || lone, where: a ? 'after' : 'before' };
  }

  function panelAt(doc, candidates) {
    for (const [sel, where] of candidates) {
      const node = doc.querySelector(sel);
      if (node) return { mode: 'panel', node, where };
    }
    return null;
  }

  function backgroundAt(node) {
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(n).backgroundColor);
      if (m && (m[4] === undefined || Number(m[4]) > 0.5)) return [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    return null;
  }
  const parseRgb = (c) => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c || '');
    return m ? { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] === undefined ? 1 : Number(m[4]) } : null;
  };
  const blendOver = (color, under) => {
    const c = parseRgb(color);
    if (!c) return `rgb(${under.join(',')})`;
    return `rgb(${c.rgb.map((v, i) => Math.round(v * c.a + under[i] * (1 - c.a))).join(',')})`;
  };
  const withAlpha = (color, a) => { const c = parseRgb(color); return c ? `rgba(${c.rgb.join(',')},${a})` : color; };
  const isDarkColor = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45;
  const lighten = (rgb, t) => `rgb(${rgb.map((c) => Math.round(c + (255 - c) * t)).join(',')})`;

  function siteColors(site, behind) {
    const dark = site?.dark ?? (behind ? isDarkColor(behind) : matchMedia('(prefers-color-scheme: dark)').matches);
    const palette = { ...(dark && behind ? { bg: lighten(behind, 0.05), line: lighten(behind, 0.14) } : null), ...site?.palette?.(document) };
    return { dark, palette };
  }

  function radiusVars(site) {
    if (site?.radius == null) return {};
    const r = site.radius;
    return { '--je-r': `${r}px`, '--je-rs': `${Math.min(r, 4)}px`, '--je-rb': `${Math.min(r, 3)}px` };
  }
  const setVars = (node, vars) => { for (const [k, v] of Object.entries(vars)) node.style.setProperty(k, v); };

  function toRgb(color) {
    const probe = el('span', { style: 'display:none' });
    probe.style.color = color;
    document.body.append(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }

  function settingsColors(anchor) {
    const box = anchor?.closest?.('.je')
      || [...document.querySelectorAll('.jiten-everywhere')].map((h) => h.shadowRoot?.querySelector('.je')).find(Boolean);
    const keys = ['bg', 'fg', 'muted', 'line', 'accent', 'warn'];
    let dark;
    let c;
    if (box) {
      const cs = getComputedStyle(box);
      dark = box.dataset.theme === 'dark';
      c = Object.fromEntries(keys.map((k) => [k, cs.getPropertyValue(`--${k}`).trim()]));
    } else {
      const site = SITES.find((x) => x.hosts.some((h) => hostIs(location.hostname, h)));
      const theme = siteColors(site, backgroundAt(document.body));
      dark = theme.dark;
      c = { ...(dark ? THEME_DEFAULTS.dark : THEME_DEFAULTS.light) };
      for (const k of keys) if (theme.palette[k]) c[k] = theme.palette[k];
    }
    for (const k of keys) c[k] = toRgb(c[k]);
    const bg = parseRgb(c.bg)?.rgb || (dark ? [28, 30, 36] : [255, 255, 255]);
    const over = (color, a) => blendOver(withAlpha(color, a), bg);
    if (!(parseRgb(c.line)?.a > 0.2)) c.line = over(c.fg, 0.18);
    const site = SITES.find((x) => x.hosts.some((h) => hostIs(location.hostname, h)));
    return {
      dark,
      glass: !!(box?.classList.contains('glass') || site?.glass),
      vars: { ...c, field: over(c.fg, 0.07), hover: over(c.fg, 0.1), here: withAlpha(c.accent, 0.15),
        onaccent: isDarkColor(parseRgb(c.accent)?.rgb || [0, 0, 0]) ? '#fff' : '#111' },
    };
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const THEME_DEFAULTS = {
    light: { bg: '#fff', fg: '#1f2328', muted: '#5f6670', line: '#d6dae0', accent: '#4f46e5', warn: '#b45309' },
    dark: { bg: '#1c1e24', fg: '#e4e6eb', muted: '#a0a6b0', line: '#363a44', accent: '#8b8cf8', warn: '#f0b35a' },
  };

  const PANEL_CSS = `
  :host{all:initial;display:block}
  .je{--bg:#fff;--fg:#1f2328;--muted:#5f6670;--line:#d6dae0;--accent:#4f46e5;--warn:#b45309;
    font:13px/1.45 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;color:var(--fg);background:var(--bg);
    border:1px solid var(--line);border-radius:var(--je-r,8px);padding:10px 12px;margin:12px 0;box-sizing:border-box;text-align:left;max-width:460px}
  .je[data-theme=dark]{--bg:#1c1e24;--fg:#e4e6eb;--muted:#a0a6b0;--line:#363a44;--accent:#8b8cf8;--warn:#f0b35a}
  .je.glass{-webkit-backdrop-filter:blur(24px) saturate(1.3);backdrop-filter:blur(24px) saturate(1.3)}
  .je.floating{position:fixed;right:16px;bottom:16px;width:min(320px,calc(100vw - 32px));max-height:70vh;overflow:auto;margin:0;
    z-index:2147483000;box-shadow:0 8px 28px rgba(0,0,0,.28)}
  .je-head{display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:6px}
  .je-head a{color:inherit;text-decoration:none}
  .je-sp{flex:1}
  .je-icon{background:none;border:0;padding:2px 4px;cursor:pointer;color:var(--muted);font:inherit;line-height:1}
  .je-icon:hover{color:var(--fg)}
  .je.collapsed .je-body{display:none}
  .je.collapsed .je-head{margin:0;cursor:pointer}
  table{border-collapse:collapse;width:100%}
  td{padding:2px 0;vertical-align:top}
  /* No fixed widths: the table gives labels one line when the box has room and wraps them
     only when it doesn't, so nothing runs past the box (MAL's column, AniList's sidebar). */
  td:first-child{color:var(--muted);padding-right:10px}
  td.je-num{white-space:nowrap}
  .floating .je-title{font-size:15px;font-weight:600}
  .je.wide{max-width:none}
  .je-headtitle{font-weight:600;min-width:0}
  .je-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px 16px;margin:2px 0 4px}
  .je-cell-label{color:var(--muted);font-size:12px}
  .je-cell-value{font-variant-numeric:tabular-nums;font-weight:600}
  td.je-status{color:var(--fg);white-space:normal;padding-bottom:4px}
  div.je-status{margin-bottom:4px}
  td.je-listlabel{color:var(--muted);white-space:normal;width:auto;padding-top:4px}
  td.je-list{white-space:normal;padding-left:8px}
  td.je-list > div{padding:1px 0}
  .je-more{font-size:12px;opacity:.8}
  table.je-sub{margin:2px 0 4px 8px;width:auto}
  table.je-sub td{font-size:12px;padding:0 10px 0 0}
  td:last-child{font-variant-numeric:tabular-nums}
  a{color:var(--accent)}
  .je-note{color:var(--muted);font-size:12px}
  .je-warn{color:var(--warn)}
  .je-actions{margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .je.band{overflow:hidden}
  .je.band .je-head{margin:-10px -12px 8px;padding:7px 12px;background:var(--band);border-bottom:1px solid var(--line)}
  .je.flat{border-width:1px 0;border-radius:0;background:transparent;padding:10px 0}
  .je.native{border:0;background:transparent;padding:0;margin:8px 0 12px;max-width:none}
  .je-nhead{display:flex;align-items:center;gap:6px}
  .je-nhead > a{color:inherit;text-decoration:none}
  .je-line{padding:0 0 3px}
  .je-lbl{font-weight:700}
  .je-facts{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px}
  .je-fact{min-width:0;overflow-wrap:anywhere}
  .je-fact-wide{grid-column:1 / -1}
  .je-line .je-status-ctl{vertical-align:middle}
  `;

  const SHARED_CSS = `
  .je-icon{background:none;border:0;padding:0 2px;margin:0;cursor:pointer;color:inherit;opacity:.65;font:inherit;line-height:0;vertical-align:-0.15em}
  .je-icon svg{display:block}
  .je-status-ctl{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:100%}
  .je-status-pick{display:inline-flex;align-items:center;gap:6px;max-width:100%}
  .je-status-line + .je-status-line{margin-top:6px}
  .je-status-name{white-space:normal;overflow-wrap:anywhere;margin-bottom:2px}
  .je-status-select{font:inherit;font-size:12px;color:inherit;background:transparent;border:1px solid rgba(128,128,128,.5);border-radius:var(--je-rs,4px);padding:1px 4px;min-width:0;flex:0 1 auto}
  .je-status-select option{color:#111;background:#fff}
  .je-star{background:none;border:0;padding:0;margin:0;cursor:pointer;color:inherit;opacity:.6;line-height:0;vertical-align:middle}
  .je-star:hover{opacity:1}
  .je-undo{background:none;border:0;padding:0 2px;margin:0;cursor:pointer;color:var(--accent,inherit);font:inherit;font-size:15px;line-height:1}
  .je-star.on{color:#f5b301;opacity:1}
  .je-star svg{display:block}
  .je-bar{display:block;position:relative;height:5px;margin:3px 0 2px;border-radius:var(--je-rb,3px);overflow:hidden;background:rgba(128,128,128,.28);min-width:70px;max-width:112px}
  .je-bar i{position:absolute;top:0;bottom:0;left:0;border-radius:var(--je-rb,3px)}
  .je-bar-coverage .je-bar-solid{background:#a855f7}
  .je-bar-coverage .je-bar-light{background:rgba(168,85,247,.4)}
  .je-bar-sentences .je-bar-solid{background:#22c55e}
  .je-bar-sentences .je-bar-light{background:rgba(34,197,94,.55)}
  .je-icon:hover{opacity:1}
  [title].je-hint{cursor:help;border-bottom:1px dotted currentColor}
  .je-row .je-more{font-size:smaller}
  .je-row table.je-sub td{padding:0 10px 0 0;border:0}
  `;

  const SETTINGS_CSS = `
  :host{all:initial}
  .pop{position:fixed;z-index:2147483646;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:var(--je-r,10px);padding:14px 16px;
    width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;
    box-shadow:0 12px 40px rgba(0,0,0,.5);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left}
  .pop.glass{-webkit-backdrop-filter:blur(24px) saturate(1.3);backdrop-filter:blur(24px) saturate(1.3)}
  .head{display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none;touch-action:none}
  .pop.moving, .pop.moving *{cursor:move!important;user-select:none}
  h3{margin:0;font-size:14px}
  label{display:flex;gap:8px;align-items:center;cursor:pointer}
  label.col{flex-direction:column;align-items:stretch;gap:4px;cursor:default}
  input[type=password],input[type=number]{padding:5px 8px;border:1px solid var(--line);border-radius:var(--je-rs,6px);background:var(--field);color:var(--fg);font:inherit}
  input:focus{outline:2px solid var(--accent);outline-offset:1px}
  input[type=checkbox]{accent-color:var(--accent);margin:0}
  .keyrow{display:flex;gap:6px}
  .keyrow input{flex:1;min-width:0}
  .keyrow button[hidden]{display:none}
  .note{font-size:12px;color:var(--muted)}
  .warn{font-size:12px;color:var(--warn)}
  .col{display:flex;flex-direction:column;gap:4px}
  .stats{display:flex;flex-direction:column;gap:2px}
  .statline{display:flex;align-items:center;gap:4px;border-radius:var(--je-rs,4px)}
  .statline.dragging{opacity:.4}
  .statline:hover{background:var(--hover)}
  .grip{cursor:grab;color:var(--muted);display:flex;padding:2px 2px}
  .grip svg{display:block}
  .seg{display:flex;border:1px solid var(--line);border-radius:var(--je-rs,6px);overflow:hidden}
  .seg button{flex:1;border:0;border-radius:0;background:var(--field);padding:5px 8px}
  .seg button + button{border-left:1px solid var(--line)}
  .seg button.on{background:var(--accent);color:var(--onaccent)}
  summary{cursor:pointer;color:var(--fg)}
  .sites{display:flex;flex-direction:column;gap:6px;margin-top:8px}
  .siterow{display:grid;grid-template-columns:6.5em 1fr;align-items:center;gap:8px}
  .siterow.here{background:var(--here);border-radius:var(--je-rs,6px);margin:0 -6px;padding:3px 6px}
  .siterow .seg button{padding:4px 6px;font-size:12px;white-space:nowrap;flex:auto}
  .sep{border-top:1px solid var(--line);margin:2px 0}
  button{padding:5px 12px;border-radius:var(--je-rs,6px);border:1px solid var(--line);background:var(--field);color:var(--fg);cursor:pointer;font:inherit}
  button:hover{border-color:var(--accent)}
  button.x{border:0;background:none;padding:2px 6px;font-size:16px;line-height:1;color:var(--muted)}
  button.x:hover{color:var(--fg)}
  a{color:var(--accent)}
  `;

  function injectSharedStyles() {
    if (document.getElementById('je-style')) return;
    document.head.append(el('style', { id: 'je-style' }, SHARED_CSS + 'tr.je-row > td{vertical-align:baseline!important}'));
  }

  // ---------------------------------------------------------------------------
  // Settings dialog
  // ---------------------------------------------------------------------------

  let closedByGearAt = 0;
  function openSettings(anchor) {
    if (anchor && Date.now() - closedByGearAt < 400) return;
    document.getElementById('je-settings')?._close?.();
    const host = el('div', { id: 'je-settings' });
    const root = host.attachShadow({ mode: 'open' });

    const fieldFor = (f) => {
      if (f.type === 'choice') {
        const buttons = f.options.map(([value, text]) => el('button', {
          type: 'button', class: settings.get(f.key) === value ? 'on' : null, 'aria-pressed': String(settings.get(f.key) === value),
          onclick: async () => {
            await settings.set(f.key, value);
            buttons.forEach((b, i) => {
              const on = f.options[i][0] === value;
              b.classList.toggle('on', on);
              b.setAttribute('aria-pressed', String(on));
            });
            onSettingsChanged();
          },
        }, text));
        const here = f.site && SITES.find((x) => x.hosts.some((h) => hostIs(location.hostname, h)))?.id === f.site;
        return el('div', { class: f.site ? 'siterow' + (here ? ' here' : '') : 'col', title: here ? 'The site you\'re on' : null }, el('span', {}, f.label), el('div', { class: 'seg', role: 'group', 'aria-label': f.label }, buttons));
      }
      const input = el('input', { type: f.type, min: f.type === 'number' ? 1000 : null, step: f.type === 'number' ? 500 : null,
        autocomplete: f.type === 'password' ? 'off' : null });
      if (f.type === 'checkbox') {
        input.checked = !!settings.get(f.key);
        input.addEventListener('change', async () => { await settings.set(f.key, input.checked); onSettingsChanged(); });
        return el('label', {}, input, f.label);
      }
      if (f.type === 'password') {
        // The saved key is never put back into the field, where the page's own scripts could read it:
        // the field only takes a new key, and Remove clears the saved one.
        const hasKey = () => !!clean(settings.get(f.key));
        const remove = el('button', { type: 'button', onclick: async () => { await settings.set(f.key, ''); show(); onSettingsChanged(true); } }, 'Remove');
        const show = () => {
          input.value = '';
          input.placeholder = hasKey() ? 'Enter a new key to replace' : 'Paste your key';
          remove.hidden = !hasKey();
          input.dispatchEvent(new Event('je-key'));
        };
        input.addEventListener('change', async () => {
          const v = input.value.trim();
          if (!v) return;
          await settings.set(f.key, v);
          show();
          onSettingsChanged(true);
        });
        show();
        return el('label', { class: 'col' }, f.label, el('div', { class: 'keyrow' }, input, remove));
      }
      input.value = settings.get(f.key) ?? '';
      if (f.type === 'number') {
        input.addEventListener('input', async () => {
          const n = Number(input.value);
          if (n > 0) { await settings.set(f.key, n); onSettingsChanged(); }
        });
      } else {
        input.addEventListener('change', async () => {
          if (input.value.trim() === clean(settings.get(f.key))) return;
          await settings.set(f.key, input.value.trim());
          onSettingsChanged(true);
        });
      }
      return el('label', { class: 'col' }, f.label, input);
    };
    const general = SETTING_FIELDS.filter((f) => !f.site && !f.stat && f.type !== 'hidden');
    const [keyField, ...rest] = general.filter((f) => f.key !== 'showRequestButton').map(fieldFor);
    const requestField = fieldFor(general.find((f) => f.key === 'showRequestButton'));

    const statList = el('div', { class: 'stats' });
    const byKey = Object.fromEntries(SETTING_FIELDS.filter((f) => f.stat).map((f) => [f.key, f]));
    let dragged = null;
    let animating = false;
    const currentOrder = () => [...statList.children].map((n) => n.dataset.key);
    for (const key of statOrder(settings.get('statOrder'))) {
      const line = el('div', { class: 'statline', draggable: 'true' }, el('span', { class: 'grip', title: 'Drag to reorder' }, gripIcon()), fieldFor(byKey[key]));
      line.dataset.key = key;
      line.addEventListener('dragstart', (e) => { dragged = line; line.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', key); });
      line.addEventListener('dragend', async () => {
        line.classList.remove('dragging');
        dragged = null;
        await settings.set('statOrder', currentOrder());
        onSettingsChanged();
      });
      line.addEventListener('dragover', (e) => {
        if (!dragged || dragged === line) return;
        e.preventDefault();
        if (animating) return;
        const r = line.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        if (before ? dragged.nextElementSibling === line : line.nextElementSibling === dragged) return;
        const lines = [...statList.children];
        const from = new Map(lines.map((n) => [n, n.getBoundingClientRect().top]));
        line[before ? 'before' : 'after'](dragged);
        for (const n of lines) {
          const dy = from.get(n) - n.getBoundingClientRect().top;
          if (!dy || n === dragged) continue;
          n.style.transition = 'none';
          n.style.transform = `translateY(${dy}px)`;
          requestAnimationFrame(() => { n.style.transition = 'transform 120ms ease'; n.style.transform = ''; });
        }
        animating = true;
        setTimeout(() => { animating = false; }, 130);
        settings.preview('statOrder', currentOrder());
        current?.render();
      });
      statList.append(line);
    }
    const siteRows = SETTING_FIELDS.filter((f) => f.site).map(fieldFor);
    const keySummary = el('summary', {});
    const showKeyState = () => { keySummary.textContent = `Jiten API key${clean(settings.get('apiKey')) ? ' (set)' : ' (optional)'}`; };
    showKeyState();
    keyField.querySelector('input').addEventListener('je-key', showKeyState);

    const close = () => {
      removeEventListener('resize', place);
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
      host.remove();
    };
    const onOutside = (e) => {
      const path = e.composedPath();
      if (path.includes(host)) return;
      if (path.some((n) => n.classList?.contains('je-icon'))) closedByGearAt = Date.now();
      close();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };

    const pop = el('div', { class: 'pop' },
      el('div', { class: 'head' }, el('h3', {}, 'Jiten Everywhere'), el('button', { class: 'x', title: 'Close', onclick: close }, '×')),
      el('details', {}, keySummary, el('div', { class: 'sites' },
        keyField,
        el('div', { class: 'note' }, 'With a key you can see your own stats (coverage, your list status), the script runs Jiten\'s duplicate check ',
          'for requests, and Jiten allows more requests a minute. Create one in ', link(`${JITEN}/settings`, 'Jiten settings'), ' → Advanced → API Key.'),
        el('div', { class: 'warn' }, 'The key gives full access to your Jiten account. It is stored in your userscript manager and only sent to api.jiten.moe.'))),
      el('div', { class: 'sep' }),
      ...rest,
      el('details', {}, el('summary', {}, 'Stats to show'), el('div', { class: 'sites' }, el('div', { class: 'note' }, 'Drag a line to reorder.'), statList)),
      requestField,
      el('div', { class: 'sep' }),
      el('details', {}, el('summary', {}, 'Where the stats show'), el('div', { class: 'sites' }, siteRows)));
    const theme = settingsColors(anchor);
    for (const [k, v] of Object.entries(theme.vars)) pop.style.setProperty(`--${k}`, v);
    pop.style.colorScheme = theme.dark ? 'dark' : 'light';
    if (theme.glass) pop.classList.add('glass');
    const here = SITES.find((x) => x.hosts.some((h) => hostIs(location.hostname, h)));
    setVars(pop, radiusVars(here));
    if (here?.edge) pop.style.borderTop = `3px solid ${here.edge}`;
    root.append(el('style', {}, SETTINGS_CSS), pop);
    document.body.append(host);
    host._close = close;

    const w = pop.offsetWidth;
    const h = () => Math.min(pop.scrollHeight, innerHeight - 16);
    let left = innerWidth - w - 16;
    let wantTop = 16;
    let below = false;
    let aboveBottom = null;
    const statsRect = () => {
      const box = anchor?.closest?.('.je');
      if (box) return box.getBoundingClientRect();
      const rows = [...document.querySelectorAll('tr.je-row')].map((n) => n.getBoundingClientRect());
      if (!rows.length) return null;
      return { left: Math.min(...rows.map((r) => r.left)), right: Math.max(...rows.map((r) => r.right)),
        top: Math.min(...rows.map((r) => r.top)), bottom: Math.max(...rows.map((r) => r.bottom)) };
    };
    const r = anchor?.isConnected ? statsRect() : null;
    if (r) {
      const sideTop = anchor.closest('.je.floating') ? r.bottom - h() : r.top;
      if (r.left - w - 10 >= 8) { left = r.left - w - 10; wantTop = sideTop; }
      else if (r.right + 10 + w <= innerWidth - 8) { left = r.right + 10; wantTop = sideTop; }
      else {
        left = Math.min(r.left, innerWidth - w - 8);
        below = innerHeight - r.bottom >= r.top;
        if (below) wantTop = r.bottom + 6;
        else aboveBottom = r.top - 6;
      }
    }
    const place = () => {
      const top = aboveBottom != null ? Math.max(8, aboveBottom - h())
        : Math.max(8, below ? Math.min(wantTop, innerHeight - 150) : Math.min(wantTop, innerHeight - h() - 8));
      pop.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`;
      pop.style.top = `${top}px`;
      pop.style.maxHeight = `${(aboveBottom != null ? aboveBottom : innerHeight - 8) - top}px`;
    };
    place();
    for (const d of pop.querySelectorAll('details')) d.addEventListener('toggle', place);
    addEventListener('resize', place);

    const firstSep = pop.querySelector('.sep');
    pop.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input, a')) return;
      if (firstSep && e.clientY >= firstSep.getBoundingClientRect().top) return;
      if (e.target.closest('details[open] .sites')) return;
      const start = { x: e.clientX, y: e.clientY, left: pop.offsetLeft, top: pop.offsetTop };
      let dragging = false;
      const move = (ev) => {
        if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        if (!dragging) { dragging = true; pop.setPointerCapture(ev.pointerId); pop.classList.add('moving'); }
        below = false;
        aboveBottom = null;
        left = start.left + ev.clientX - start.x;
        wantTop = start.top + ev.clientY - start.y;
        place();
      };
      const up = () => {
        pop.removeEventListener('pointermove', move);
        pop.removeEventListener('pointerup', up);
        pop.classList.remove('moving');
        if (dragging) {
          const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
          pop.addEventListener('click', swallow, true);
          setTimeout(() => pop.removeEventListener('click', swallow, true));
        }
      };
      pop.addEventListener('pointermove', move);
      pop.addEventListener('pointerup', up);
    });

    setTimeout(() => {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    });
  }

  // ---------------------------------------------------------------------------
  // Rendering: a panel (most sites) or rows in VNDB's own table
  // ---------------------------------------------------------------------------

  function statusControl(view, deck) {
    const select = el('select', { class: 'je-status-select', title: 'Your status on Jiten' },
      DECK_STATUS.map(([v, text]) => { const o = el('option', { value: v }, text); if (v === (deck.status || 0)) o.selected = true; return o; }));
    const star = el('button', { class: 'je-star' + (deck.isFavourite ? ' on' : ''), title: deck.isFavourite ? 'Favourite (click to remove)' : 'Add to favourites' },
      starIcon(!!deck.isFavourite));
    const note = el('span', { class: 'je-warn je-status-note' });
    const fail = (e) => { note.textContent = ` Couldn't save: ${e.message}`; };
    select.addEventListener('change', async () => {
      const status = Number(select.value);
      const had = deck.status || 0;
      select.disabled = true;
      note.textContent = '';
      try {
        const r = await jitenApi.setStatus(deck.deckId, status);
        deck.status = r?.status ?? status;
        if (r && 'listEntry' in r) deck.listEntry = r.listEntry;
        // Removing deletes the reading history too; Jiten returns the state before the change, which
        // the undo arrow after the dropdown puts back, as Undo does on Jiten's own site.
        deck.undo = status === 0 && had !== 0 && r?.previous?.length ? r.previous : null;
        view.render();
      } catch (e) { select.value = had; select.disabled = false; fail(e); }
    });
    const undo = deck.undo && el('button', { class: 'je-undo', title: 'Undo removal (puts back the status and reading history)' }, '↶');
    undo?.addEventListener('click', async (e) => {
      e.preventDefault();
      undo.disabled = true;
      note.textContent = '';
      try {
        const r = await jitenApi.restore(deck.undo);
        const back = r?.decks?.find((d) => d.deckId === deck.deckId);
        deck.status = back?.status ?? deck.status;
        if (back && 'listEntry' in back) deck.listEntry = back.listEntry;
        deck.undo = null;
        view.render();
      } catch (err) { undo.disabled = false; fail(err); }
    });
    star.addEventListener('click', async (e) => {
      e.preventDefault();
      star.disabled = true;
      note.textContent = '';
      try {
        const r = await jitenApi.setFavourite(deck.deckId, !deck.isFavourite);
        deck.isFavourite = r?.isFavourite ?? !deck.isFavourite;
        view.render();
      } catch (err) { star.disabled = false; fail(err); }
    });
    return el('span', { class: 'je-status-ctl' }, el('span', { class: 'je-status-pick' }, select, undo, star), note);
  }

  function starIcon(filled) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '1.05em');
    svg.setAttribute('height', '1.05em');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z');
    path.setAttribute('fill', filled ? 'currentColor' : 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  function shownMatches(result) {
    const strong = result.matches.filter((m) => m.strength > 0).slice(0, 5);
    const weak = result.matches.filter((m) => m.strength === 0).slice(0, 4);
    return { strong, weak, count: strong.length + weak.length };
  }

  function viewRows(view) {
    const { result, page } = view;
    const gear = el('button', { class: 'je-icon', title: 'Jiten Everywhere settings', onclick: (e) => { e.preventDefault(); openSettings(e.currentTarget); } }, gearIcon());
    const rows = [];
    const status = (...value) => rows.push({ label: 'Jiten', value });

    if (result.state === 'loading') status('Checking…');
    else if (result.state === 'error') {
      const retry = el('a', { href: '#', onclick: (e) => { e.preventDefault(); view.recheck(); } }, 'Retry');
      status(el('span', { class: 'je-warn' }, `Couldn't check Jiten: ${result.error?.message || result.error}`), ' ', retry);
    } else if (result.state === 'found') {
      status(joinNodes(result.decks.map((d) => {
        const a = link(deckUrl(d.deckId), deckName(d), [MT_LABEL[d.mediaType], otherTitles(d)].filter(Boolean).join(' · '));
        a.classList.add('je-title');
        return a;
      })));
      const statusValue = () => (result.decks.length === 1 ? statusControl(view, result.decks[0])
        : result.decks.map((d) => el('div', { class: 'je-status-line' }, el('div', { class: 'je-note je-status-name' }, deckName(d)), statusControl(view, d))));
      rows.push(...statRows(result.decks, settings.all()).map((r) => (r.status ? { ...r, value: statusValue() } : r)));
      if (result.byTitle) rows.push({ label: '', value: el('span', { class: 'je-note' }, 'Found by its title. Jiten doesn\'t link this deck to this page.') });
    } else {
      const { strong, weak } = shownMatches(result);
      if (result.requests.length) status('Already requested.');
      else if (result.matches.some((m) => m.strength >= 3)) status('Probably on Jiten under another link: Jiten\'s duplicate check matched it.');
      else if (strong.length + weak.length === 1) status('Not linked to this page. Check this one before requesting:');
      else if (result.matches.length) status('Not linked to this page. Check these before requesting:');
      else if (result.authoritative) status('Not on Jiten, and no open request.');
      else status('No Jiten deck found for this page.');

      if (result.requests.length) {
        rows.push({
          list: true,
          label: 'Requested',
          value: result.requests.map((q) => el('div', {}, link(`${JITEN}/requests/${q.id}`,
            `${clean(q.title)} (${REQUEST_STATUS[q.status] || 'open'} · ${q.upvoteCount} upvote${q.upvoteCount === 1 ? '' : 's'})`))),
        });
      }
      const matchLinks = (list) => list.map(({ deck }) => {
        const shown = view.matchStats.get(deck.deckId);
        return el('div', {},
          link(deckUrl(deck.deckId), `${deckName(deck)} (${MT_LABEL[deck.mediaType] || '?'})`, otherTitles(deck)), ' ',
          el('a', { href: '#', class: 'je-more', onclick: (e) => { e.preventDefault(); view.toggleMatchStats(deck.deckId); } },
            shown ? 'hide stats' : 'stats'),
          shown?.state === 'loading' && el('div', { class: 'je-note' }, 'Loading…'),
          shown?.state === 'error' && el('div', { class: 'je-warn' }, shown.error.message),
          shown?.state === 'done' && el('table', { class: 'je-sub' }, statRows([shown.deck], settings.all()).map((r) => el('tr', {}, rowNode(r)))));
      });
      if (strong.length) rows.push({ list: true, label: strong.length === 1 ? 'Possible match' : 'Possible matches', value: matchLinks(strong) });
      if (weak.length) rows.push({ list: true, label: 'Similar titles', value: matchLinks(weak) });

      if (result.keyRejected) rows.push({ label: '', value: el('span', { class: 'je-warn' }, 'Your API key was rejected, so existing requests weren\'t checked.') });
      else if (!result.authoritative) {
        rows.push({ label: '', value: el('span', { class: 'je-note' }, 'Existing requests can only be checked with an API key (see settings).') });
      }
      const rejected = result.closedRequests?.find((q) => q.status === 4);
      if (rejected) {
        rows.push({ label: '', value: el('span', { class: 'je-note' }, 'A similar request was rejected before: ', link(`${JITEN}/requests/${rejected.id}`, clean(rejected.title))) });
      }
    }
    return { rows, gear, actions: requestActions(view) };
  }

  function requestActions(view) {
    const { result } = view;
    if (!settings.get('showRequestButton')) return null;
    if (!['none', 'possible', 'requested'].includes(result.state) && !(result.state === 'found' && result.byTitle)) return null;
    if (view.handoffLink) return link(view.handoffLink, 'Open the Jiten request form →');
    const label = result.state === 'found' ? 'Not this? Request it on Jiten'
      : result.state === 'requested' ? 'Different work? Request it on Jiten'
      : !result.matches.length ? 'Request on Jiten'
        : shownMatches(result).count === 1 ? 'Not this? Request it on Jiten' : 'None of these? Request it on Jiten';
    return el('a', { href: `${JITEN}/requests/new`, class: 'je-request', onclick: (e) => { e.preventDefault(); view.request(); } }, label);
  }

  const clampPct = (n) => `${Math.max(0, Math.min(100, n)).toFixed(1)}%`;
  const barNode = ({ solid, light, color, title }) => el('span', { class: `je-bar je-bar-${color}`, title },
    el('i', { class: 'je-bar-light', style: `width:${clampPct(light)}` }), el('i', { class: 'je-bar-solid', style: `width:${clampPct(solid)}` }));

  function rowNode(r, inTable = false) {
    const tag = 'td';
    if (!r.label) return inTable ? [el(tag), el(tag, {}, r.value)] : el(tag, { colspan: 2, class: 'je-status' }, r.value);
    const labelCell = r.hint ? el('span', { class: 'je-hint', title: r.hint }, r.label) : r.label;
    const wraps = !r.key || r.key === 'showStatus';
    return [el(tag, {}, labelCell), el(tag, { class: wraps ? null : 'je-num', title: r.bar?.title }, r.value, r.bar && barNode(r.bar))];
  }

  function renderPanel(view) {
    const { rows, gear, actions } = viewRows(view);
    const root = view.shadow;
    root.replaceChildren();
    const floating = view.mountMode === 'floating';
    const wide = !floating && view.site.wide;
    const box = el('div', { class: 'je' + (floating ? ' floating' : '') + (wide ? ' wide' : '') + (floating && view.collapsed ? ' collapsed' : '') });
    if (!floating && view.site.flat) {
      box.classList.add('flat');
      box.style.fontFamily = getComputedStyle(document.body).fontFamily;
    }
    const { dark, palette } = siteColors(view.site, backgroundAt(floating ? document.body : view.host.parentElement));
    box.dataset.theme = dark ? 'dark' : 'light';
    if (view.site.glass) box.classList.add('glass');
    setVars(box, radiusVars(view.site));
    if (view.site.edge) box.style.borderTop = `3px solid ${view.site.edge}`;
    if (view.site.band && !floating && !dark) { box.classList.add('band'); box.style.setProperty('--band', view.site.band); }
    for (const [k, val] of Object.entries(palette)) if (val) box.style.setProperty(`--${k}`, val);
    const toggle = floating ? el('button', {
      class: 'je-icon', title: view.collapsed ? 'Expand' : 'Collapse',
      onclick: (e) => {
        e.stopPropagation();
        view.collapsed = !view.collapsed;
        try { localStorage.setItem('je-collapsed', view.collapsed ? '1' : ''); } catch { /* ignore */ }
        renderPanel(view);
      },
    }, view.collapsed ? '▴' : '▾') : null;
    if (wide) {
      const [status, ...rest] = rows;
      const found = view.result.state === 'found';
      const stats = rest.filter((r) => r.key);
      const others = rest.filter((r) => !r.key);
      box.append(
        el('div', { class: 'je-head' }, link(JITEN, 'Jiten'), found && el('span', { class: 'je-headtitle' }, status.value), el('span', { class: 'je-sp' }), gear),
        el('div', { class: 'je-body' },
          !found && el('div', { class: 'je-status' }, status.value),
          stats.length > 0 && el('div', { class: 'je-grid' }, stats.map((r) => el('div', {},
            el('div', { class: 'je-cell-label' }, r.hint ? el('span', { class: 'je-hint', title: r.hint }, r.label) : r.label),
            el('div', { class: 'je-cell-value', title: r.bar?.title }, r.value, r.bar && barNode(r.bar))))),
          others.length > 0 && el('table', {}, others.map((r) => el('tr', {}, rowNode(r)))),
          actions && el('div', { class: 'je-actions' }, actions)));
      root.append(el('style', {}, PANEL_CSS + SHARED_CSS), box);
      return;
    }
    const look = !floating && view.site.native?.(document);
    if (look) {
      renderNative(view, box, look, rows, gear, actions);
      root.append(el('style', {}, PANEL_CSS + SHARED_CSS), box);
      return;
    }
    box.append(
      el('div', {
        class: 'je-head',
        onclick: (e) => {
          if (!floating || !view.collapsed || e.composedPath().some((n) => n === gear || n === toggle)) return;
          e.preventDefault();
          toggle.click();
        },
      }, link(JITEN, 'Jiten'), el('span', { class: 'je-sp' }), gear, toggle),
      el('div', { class: 'je-body' },
        el('table', {}, rows.flatMap((r, i) => (i === 0 ? [el('tr', {}, el('td', { colspan: 2, class: 'je-status' }, r.value))]
          : r.list ? [el('tr', {}, el('td', { colspan: 2, class: 'je-listlabel' }, r.label)), el('tr', {}, el('td', { colspan: 2, class: 'je-list' }, r.value))]
            : [el('tr', {}, rowNode(r))]))),
        actions && el('div', { class: 'je-actions' }, actions)));
    root.append(el('style', {}, PANEL_CSS + SHARED_CSS), box);
  }

  function renderNative(view, box, look, rows, gear, actions) {
    box.classList.add('native');
    const css = (styles) => Object.entries(styles).map(([k, v]) => `${k}:${v}`).join(';');
    if (look.link) box.style.setProperty('--accent', look.link);
    if (look.body.color) box.style.setProperty('--fg', look.body.color);
    const label = (r) => [r.hint ? el('span', { class: 'je-hint', title: r.hint }, r.label) : r.label, ':'];
    let lines;
    if (look.layout === 'facts') {
      const fact = (r, wide) => el('div', { class: 'je-fact' + (wide ? ' je-fact-wide' : ''), title: r.bar?.title },
        el('div', { class: 'je-lbl', style: css(look.label || {}) }, r.hint ? el('span', { class: 'je-hint', title: r.hint }, r.label) : r.label),
        el('div', {}, r.value, r.bar && barNode(r.bar)));
      lines = [el('div', { class: 'je-facts' }, rows.map((r, i) => (i === 0 || !r.label
        ? el('div', { class: 'je-fact je-fact-wide' }, r.value)
        : fact(r, r.list || r.key === 'showStatus'))))];
    } else {
      lines = rows.map((r, i) => {
        if (i === 0 || !r.label) return el('div', { class: 'je-line' }, r.value);
        if (r.list) return el('div', { class: 'je-line' }, el('span', { class: 'je-lbl' }, r.label), el('div', { class: 'je-list' }, r.value));
        return el('div', { class: 'je-line', title: r.bar?.title }, el('span', { class: 'je-lbl' }, ...label(r)), ' ', r.value, r.bar && barNode(r.bar));
      });
    }
    box.append(
      el('div', { class: 'je-nhead', style: css(look.head) }, link(JITEN, 'Jiten'), el('span', { class: 'je-sp' }), gear),
      el('div', { style: css(look.body) }, ...lines, actions && el('div', { class: 'je-actions' }, actions)));
  }

  function renderRows(view) {
    const { rows, gear, actions } = viewRows(view);
    view.trs?.forEach((tr) => tr.remove());
    const [first, ...rest] = rows;
    const trs = [
      el('tr', { class: 'je-row' }, el('td', {}, link(JITEN, first.label)), el('td', {}, first.value, ' ', gear)),
      ...rest.map((r) => el('tr', { class: 'je-row' }, rowNode(r, true))),
    ];
    if (actions) trs.push(el('tr', { class: 'je-row' }, el('td', {}), el('td', {}, actions)));
    let after = view.mountTarget.after;
    for (const tr of trs) { setVars(tr, radiusVars(view.site)); after.after(tr); after = tr; }
    view.trs = trs;
  }

  // ---------------------------------------------------------------------------
  // One work page: check Jiten, show the result, handle the request button
  // ---------------------------------------------------------------------------

  const SENTENCE_KEYS = ['showSentenceCoverage'];
  async function addSentenceMetrics(decks) {
    if (!jitenApi.hasKey || !SENTENCE_KEYS.some((k) => settings.get(k))) return decks;
    return Promise.all(decks.map(async (d) => {
      try { return { ...d, ...(await jitenApi.sentenceMetrics(d)) }; } catch { return d; }
    }));
  }
  async function withSentenceMetrics(result) {
    if (result.state === 'found') result.decks = await addSentenceMetrics(result.decks);
    return result;
  }

  async function collectInfo(site, ref) {
    try {
      const info = await site.collect(ref, document);
      return { extraRefs: [], ...info, siteTypes: site.types, titles: info.titles || {} };
    } catch {
      const main = ogTitle(document) || cleanPageTitle(document.title);
      return { mediaType: null, siteTypes: site.types, titles: { main, jp: hasJapanese(main) ? main : null }, extraRefs: [] };
    }
  }

  function startView({ site, ref }, key) {
    const view = {
      key, site, ref,
      result: { state: 'loading' },
      collapsed: (() => { try { return !!localStorage.getItem('je-collapsed'); } catch { return false; } })(),
      destroyed: false,
    };

    view.unmount = () => {
      view.trs?.forEach((tr) => tr.remove());
      view.host?.remove();
      view.trs = view.host = view.shadow = view.mountMode = null;
    };

    view.mount = () => {
      if (view.destroyed) return;
      const floating = placementOf(site) === 'corner';
      const mounted = view.mountMode === 'rows' ? view.trs?.[0]?.isConnected : view.host?.isConnected;
      if (mounted && (view.mountMode === 'floating') === floating) return;
      const target = floating ? null : site.mount(document);
      view.unmount();
      if (!floating && !target) return;
      if (target?.mode === 'rows') {
        injectSharedStyles();
        view.mountMode = 'rows';
        view.mountTarget = target;
      } else {
        view.host = el('div', { class: 'jiten-everywhere' });
        view.shadow = view.host.attachShadow({ mode: 'open' });
        if (target) {
          view.mountMode = 'panel';
          target.node[target.where](view.host);
        } else {
          view.mountMode = 'floating';
          document.body.append(view.host);
        }
      }
      view.render();
    };

    view.render = () => {
      if (view.destroyed) return;
      if (view.mountMode === 'rows') renderRows(view); else if (view.shadow) renderPanel(view);
    };

    view.destroy = () => {
      view.destroyed = true;
      view.unmount();
    };

    view.check = async () => {
      view.page ||= await (async () => {
        const info = await collectInfo(site, ref);
        return { refs: [ref, ...info.extraRefs], info };
      })();
      return withSentenceMetrics(await checkJiten(view.page, jitenApi));
    };

    view.matchStats = new Map();
    view.toggleMatchStats = async (deckId) => {
      if (view.matchStats.has(deckId)) { view.matchStats.delete(deckId); view.render(); return; }
      view.matchStats.set(deckId, { state: 'loading' });
      view.render();
      let entry;
      try {
        const d = await jitenApi.detail(deckId);
        let deck = d && (d.mainDeck.parentDeckId && d.parentDeck ? ((await jitenApi.detail(d.parentDeck.deckId))?.mainDeck || d.parentDeck) : d.mainDeck);
        if (deck) deck = (await addSentenceMetrics([deck]))[0];
        entry = deck ? { state: 'done', deck } : { state: 'error', error: new Error('Jiten has no such deck.') };
      } catch (error) {
        entry = { state: 'error', error };
      }
      if (!view.matchStats.has(deckId)) return;
      view.matchStats.set(deckId, entry);
      view.render();
    };

    view.recheck = async () => {
      view.matchStats.clear();
      view.result = { state: 'loading' };
      view.handoffLink = null;
      view.render();
      try { view.result = await view.check(); } catch (error) { view.result = { state: 'error', error }; }
      view.render();
    };

    view.request = async () => {
      const url = await openRequestForm(view.page);
      if (url) { view.handoffLink = url; view.render(); }
    };

    view.mount();
    view.recheck();
    return view;
  }

  async function openRequestForm(page) {
    const ref = page.refs[0];
    const mediaType = page.info.mediaType;
    await store.set('pendingRequest', { mediaType, title: requestTitle(page.info), url: ref.url, ts: Date.now() });
    const url = `${JITEN}/requests/new${mediaType ? `?mediaType=${mediaType}` : ''}`;
    if (typeof GM_openInTab === 'function') {
      GM_openInTab(url, { active: true, insert: true, setParent: true });
      return null;
    }
    if (GM4?.openInTab) {
      GM4.openInTab(url, false);
      return null;
    }
    return url;
  }

  // ---------------------------------------------------------------------------
  // jiten.moe/requests/new: fill the form from the pending request. Never submits.
  // ---------------------------------------------------------------------------

  function setVueValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fieldByLabel(re) {
    for (const label of document.querySelectorAll('label')) {
      if (re.test(clean(label.textContent))) return label.parentElement;
    }
    return null;
  }

  function findRequestForm() {
    const titleField = fieldByLabel(/^Title\s*\*?$/);
    const urlField = fieldByLabel(/^External URL/);
    const typeField = fieldByLabel(/^Media Type/);
    const title = titleField?.querySelector('input');
    const url = urlField?.querySelector('input');
    return title && url ? { title, url, typeField } : null;
  }

  function currentMediaTypeLabel(form) {
    const label = form.typeField?.querySelector('.p-select-label');
    const text = clean(label?.textContent);
    if (!text || label.classList.contains('p-placeholder') || /^Select media type$/i.test(text)) return null;
    return text;
  }

  function vueComponentFor(node) {
    let container = node;
    while (container && !container._vnode) container = container.parentElement;
    if (!container) return null;
    const stack = [container._vnode];
    let budget = 20000;
    while (stack.length && budget-- > 0) {
      const v = stack.pop();
      if (!v || typeof v !== 'object') continue;
      if (v.component) {
        if (v.component.subTree?.el === node) return v.component;
        stack.push(v.component.subTree);
      }
      if (v.suspense) stack.push(v.suspense.activeBranch);
      if (Array.isArray(v.children)) stack.push(...v.children);
    }
    return null;
  }

  function selectMediaType(form, label) {
    const root = form.typeField?.querySelector('.p-select');
    const comp = root && !root.classList.contains('p-disabled') ? vueComponentFor(root) : null;
    const props = comp?.props;
    if (!comp?.emit || !Array.isArray(props?.options)) return;
    const labelOf = (o) => (props.optionLabel && o && typeof o === 'object' ? o[props.optionLabel] : o);
    const option = props.options.find((o) => labelOf(o) === label);
    if (option === undefined) return;
    const value = props.optionValue && typeof option === 'object' ? option[props.optionValue] : option;
    comp.emit('update:modelValue', value);
    comp.emit('change', { originalEvent: null, value });
  }

  // Vue sets __vue_app__ on its mount container once the page has hydrated. Before that,
  // v-model writes its own (empty) value back into the inputs and wipes anything filled in.
  async function waitForVueApp(timeout = 1500) {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) {
      try { if (document.querySelector('#__nuxt')?.__vue_app__) return; } catch { /* not visible from this sandbox */ }
    }
  }

  // Marks a field as written by a script: Jiten Request Enhancer (another userscript) then doesn't open its search for
  // the title, or look the link up again (the title is already filled), until the user changes it.
  function fillMarked(input, value) {
    input.dataset.jreFilled = value;
    setVueValue(input, value);
  }

  function jitenRequestPage() {
    let handledPath = null;
    const tick = async () => {
      const onForm = /^\/requests\/new\/?$/.test(location.pathname);
      if (!onForm) { handledPath = null; return; }
      if (handledPath || !findRequestForm()) return;
      handledPath = location.pathname;
      const p = await store.get('pendingRequest');
      if (!p || !(Date.now() - p.ts < 30 * 60e3)) return;
      const queryType = Number(new URLSearchParams(location.search).get('mediaType')) || null;
      if (queryType && p.mediaType && queryType !== p.mediaType) return;
      await waitForVueApp();

      // Fill, then check again a few times: a late hydration or re-render can empty the fields.
      // A field is only refilled while empty and not focused, so anything the user typed or cleared stays.
      let typeTried = false;
      const apply = () => {
        const form = findRequestForm();
        if (!form || document.getElementById('isUpdate')?.checked) return false;
        const empty = (input) => !clean(input.value) && document.activeElement !== input;
        if (p.title && empty(form.title)) fillMarked(form.title, p.title);
        if (p.url && empty(form.url)) fillMarked(form.url, p.url);
        if (p.mediaType && !typeTried && !currentMediaTypeLabel(form)) { typeTried = true; selectMediaType(form, MT_LABEL[p.mediaType]); }
        return true;
      };
      if (!apply()) return;
      for (const wait of [300, 700, 1500, 2500]) {
        await sleep(wait);
        if (!apply()) break;
      }
      await store.delete('pendingRequest');
    };
    new MutationObserver(debounce(tick, 150)).observe(document.body, { childList: true, subtree: true });
    tick();
  }

  // ---------------------------------------------------------------------------
  // Routing (sites that change page without reloading: AniList, IGDB, IMDb)
  // ---------------------------------------------------------------------------

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  let current = null;

  function route() {
    let m = matchPage(new URL(location.href), document);
    if (m && placementOf(m.site) === 'off') m = null;
    const key = m ? `${m.site.id}:${m.ref.linkType}:${m.ref.kind}:${m.ref.id}` : null;
    if (current && current.key !== key) { current.destroy(); current = null; }
    if (!m) return;
    if (current) current.mount();
    else current = startView(m, key);
  }

  function onSettingsChanged(keyChanged = false) {
    if (hostIs(location.hostname, 'jiten.moe')) return;
    if (!activated) activate();
    route();
    if (!current) return;
    current.mount();
    if (keyChanged) current.recheck();
    else current.render();
  }

  settingsReady.then(() => {
    gmMenu?.('Jiten Everywhere settings', () => openSettings());
    if (hostIs(location.hostname, 'jiten.moe')) {
      jitenRequestPage();
      return;
    }
    const here = SITES.find((x) => x.hosts.some((h) => hostIs(location.hostname, h)));
    defaultsHere = siteDefaults(here?.id);
    if (here && placementOf(here) !== 'off') activate();
  });

  let activated = false;
  function activate() {
    if (activated) return;
    activated = true;
    new MutationObserver(debounce(route, 250)).observe(document.documentElement, { childList: true, subtree: true });
    const themeObserver = new MutationObserver(debounce(() => current?.render(), 100));
    for (const n of [document.documentElement, document.body]) themeObserver.observe(n, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    route();
  }
})();
