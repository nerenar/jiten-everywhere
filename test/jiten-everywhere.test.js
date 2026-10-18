'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const je = require('../jiten-everywhere.user.js');

const { LINK, MT } = je;
const page = (url, doc) => je.matchPage(new URL(url), doc);

test('work pages map to the link Jiten stores', () => {
  const cases = [
    ['https://vndb.org/v123', { linkType: LINK.VNDB, kind: null, id: 'v123', url: 'https://vndb.org/v123' }],
    ['https://anilist.co/anime/2121/Sea-Song/', { linkType: LINK.ANILIST, kind: 'anime', id: '2121', url: 'https://anilist.co/anime/2121' }],
    ['https://anilist.co/manga/3003/characters', { linkType: LINK.ANILIST, kind: 'manga', id: '3003', url: 'https://anilist.co/manga/3003' }],
    ['https://myanimelist.net/manga/1/Night_Watch', { linkType: LINK.MAL, kind: 'manga', id: '1', url: 'https://myanimelist.net/manga/1' }],
    ['https://www.themoviedb.org/movie/1234-falling-stars?language=ja', { linkType: LINK.TMDB, kind: 'movie', id: '1234', url: 'https://www.themoviedb.org/movie/1234' }],
    ['https://www.themoviedb.org/tv/4321-sea-song', { linkType: LINK.TMDB, kind: 'tv', id: '4321', url: 'https://www.themoviedb.org/tv/4321' }],
    ['https://www.imdb.com/title/tt1234567/', { linkType: LINK.IMDB, kind: null, id: 'tt1234567', url: 'https://www.imdb.com/title/tt1234567/' }],
    ['https://www.imdb.com/ja/title/tt1234567/', { linkType: LINK.IMDB, kind: null, id: 'tt1234567', url: 'https://www.imdb.com/title/tt1234567/' }],
    ['https://www.igdb.com/games/star-quest-vii', { linkType: LINK.IGDB, kind: null, id: 'star-quest-vii', url: 'https://www.igdb.com/games/star-quest-vii' }],
    ['https://ncode.syosetu.com/n1234AB/', { linkType: LINK.SYOSETU, kind: null, id: 'n1234ab', url: 'https://ncode.syosetu.com/n1234ab/' }],
    ['https://bookmeter.com/books/123456', { linkType: LINK.BOOKMETER, kind: null, id: '123456', url: 'https://bookmeter.com/books/123456' }],
  ];
  for (const [url, ref] of cases) assert.deepEqual(page(url)?.ref, ref, url);
});

test('pages that are not a work, or a sub page without the info, are ignored', () => {
  for (const url of [
    'https://vndb.org/v123/chars', 'https://vndb.org/r123', 'https://anilist.co/home', 'https://myanimelist.net/anime/season',
    'https://www.themoviedb.org/tv/4321/season/1', 'https://www.imdb.com/title/tt1234567/reviews',
    'https://ncode.syosetu.com/n1234ab/5/', 'https://www.igdb.com/games/star-quest-vii/reviews',
  ]) assert.equal(page(url), null, url);
});

test('Letterboxd uses the TMDB id the page carries', () => {
  const doc = { body: { dataset: { tmdbId: '1234', tmdbType: 'movie' } }, querySelector: () => null };
  assert.deepEqual(page('https://letterboxd.com/film/falling-stars/', doc).ref,
    { linkType: LINK.TMDB, kind: 'movie', id: '1234', url: 'https://www.themoviedb.org/movie/1234' });
  const noId = { body: { dataset: {} }, querySelector: () => ({ href: 'https://www.themoviedb.org/tv/4321/' }) };
  assert.equal(page('https://letterboxd.com/film/x/', noId).ref.kind, 'tv');
});

test('stored links parse whatever their shape', () => {
  assert.deepEqual(je.parseLinkKey(LINK.MAL, 'https://myanimelist.net/anime/1/Space_Courier'), { linkType: LINK.MAL, kind: 'anime', id: '1' });
  assert.deepEqual(je.parseLinkKey(LINK.TMDB, 'themoviedb.org/movie/550-example-film'), { linkType: LINK.TMDB, kind: 'movie', id: '550' });
  assert.equal(je.parseLinkKey(LINK.VNDB, 'https://vndb.org/v170').id, 'v170');
  assert.equal(je.parseLinkKey(LINK.MAL, 'https://anilist.co/anime/1'), null);
});

test('a deck linked to the other MAL/TMDB kind with the same number is dropped', () => {
  const ref = { linkType: LINK.MAL, kind: 'anime', id: '1' };
  assert.equal(je.deckHasLink({ links: [{ linkType: LINK.MAL, url: 'https://myanimelist.net/manga/1' }] }, ref), false);
  assert.equal(je.deckHasLink({ links: [{ linkType: LINK.MAL, url: 'https://myanimelist.net/anime/1/Space_Courier' }] }, ref), true);
  // Unreadable or missing links never hide a deck
  assert.equal(je.deckHasLink({ links: [{ linkType: LINK.MAL, url: 'https://myanimelist.net/weird' }] }, ref), true);
  assert.equal(je.deckHasLink({ links: [] }, ref), true);
});

test('media type rules', () => {
  assert.equal(je.anilistMediaType({ type: 'ANIME', format: 'MOVIE' }), MT.ANIME);
  assert.equal(je.anilistMediaType({ type: 'MANGA', format: 'NOVEL' }), MT.NOVEL);
  assert.equal(je.anilistMediaType({ type: 'MANGA', format: 'ONE_SHOT' }), MT.MANGA);
  assert.equal(je.malMediaType('manga', 'Light Novel'), MT.NOVEL);
  assert.equal(je.malMediaType('manga', 'Manhwa'), MT.MANGA);
  assert.equal(je.screenMediaType({ kind: 'movie', animation: true }), MT.ANIME);
  assert.equal(je.screenMediaType({ kind: 'tv', animation: true }), MT.ANIME);
  assert.equal(je.screenMediaType({ kind: 'tv', animation: false }), MT.DRAMA);
  assert.equal(je.screenMediaType({ kind: 'movie', animation: false }), MT.MOVIE);
  assert.equal(je.screenMediaType({ kind: 'movie', game: true }), MT.VIDEOGAME);
});

test('AniList Japanese title skips Korean and Chinese originals', () => {
  assert.equal(je.anilistJapaneseTitle({ countryOfOrigin: 'JP', title: { native: 'ウミノウタ' } }), 'ウミノウタ');
  assert.equal(je.anilistJapaneseTitle({ countryOfOrigin: 'KR', title: { native: '나의 모험' }, synonyms: ['僕の冒険'] }), '僕の冒険');
  assert.equal(je.anilistJapaneseTitle({ countryOfOrigin: 'CN', title: { native: '星空故事' }, synonyms: [] }), null);
});

test('title strength', () => {
  const deck = { originalTitle: '星降る夜の物語', romajiTitle: 'Hoshi Furu Yoru no Monogatari', englishTitle: 'Night of Falling Stars' };
  assert.equal(je.titleStrength(['星降る夜の物語'], deck), 2);
  assert.equal(je.titleStrength(['night of  falling stars!'], deck), 2);
  assert.equal(je.titleStrength(['Night of Falling Stars (Special Edition)'], deck), 1);
  assert.equal(je.titleStrength(['ウミノウタ'], { originalTitle: 'SEA SONG' }), 0);
  assert.equal(je.titleStrength(['SEA'], { originalTitle: 'SEA SONG' }), 0); // too short to count as contained
});

test('formatting', () => {
  assert.equal(je.formatTime(626352 / 14000), '44h 44m');
  assert.equal(je.formatTime(0.5), '30m');
  assert.equal(je.formatTime(1.999), '2h');
  assert.equal(je.formatSpeech(894452733), '248h 27m');
  assert.equal(je.formatSpeech(45000), '45s');
  assert.equal(je.difficultyText({ difficultyRaw: 2.86, difficulty: 2 }), '2.9/5 · Average');
  assert.equal(je.difficultyText({ difficulty: -1 }), null);
});

test('stat rows follow settings and media type', () => {
  const vn = { mediaType: MT.VN, characterCount: 626352, wordCount: 260715, uniqueWordCount: 16238, uniqueKanjiCount: 2093,
    difficulty: 2, difficultyRaw: 2.86, averageSentenceLength: 16.05, dialoguePercentage: 46.4, speechDuration: 0, childrenDeckCount: 0 };
  const rows = je.statRows([vn], je.DEFAULTS);
  assert.deepEqual(rows.map((r) => r.label), ['Characters', 'Reading time (est.)', 'Difficulty', 'Unique words', 'Unique kanji']);
  assert.equal(rows[0].value, '626,352');
  const two = je.statRows([vn, { ...vn, characterCount: 1000 }], { ...je.DEFAULTS, showReadingTime: false });
  assert.equal(two[0].value, '626,352 / 1,000');
  const anime = { mediaType: MT.ANIME, characterCount: 10, speechDuration: 3600e3, childrenDeckCount: 12, uniqueWordCount: 5 };
  const labels = je.statRows([anime], je.DEFAULTS).map((r) => r.label);
  assert.ok(labels.includes('Speech duration') && labels.includes('Episodes') && !labels.includes('Reading time (est.)'));
});

// A fake Jiten API for the check.
function fakeApi({ links = {}, decks = {}, search = {}, dup = null, dupError = null } = {}) {
  return {
    hasKey: !!(dup || dupError),
    calls: [],
    async byLinkId(ref) { this.calls.push(['link', ref.linkType, ref.id]); return links[`${ref.linkType}:${ref.id}`] || []; },
    async detail(id) { return decks[id] || null; },
    async suggestions(q) { this.calls.push(['search', q]); return search[q] || []; },
    async duplicateCheck(args) { this.calls.push(['dup', args]); if (dupError) throw dupError; return dup; },
  };
}
const info = (titles, mediaType = MT.ANIME) => ({ titles, mediaType });

test('found through a cross id, child shown as its series', async () => {
  const series = { deckId: 1, mediaType: MT.ANIME, links: [{ linkType: LINK.MAL, url: 'https://myanimelist.net/anime/2121' }] };
  const api = fakeApi({
    links: { [`${LINK.MAL}:2121`]: [2] },
    decks: { 2: { mainDeck: { deckId: 2, parentDeckId: 1, links: [] }, parentDeck: series } },
  });
  const r = await je.checkJiten({ refs: [{ linkType: LINK.ANILIST, kind: 'anime', id: '2121' }, { linkType: LINK.MAL, kind: 'anime', id: '2121' }], info: info({}) }, api);
  assert.equal(r.state, 'found');
  assert.deepEqual(r.decks.map((d) => d.deckId), [1]);
});

test('linked to the wrong MAL kind: not found by link, so titles are searched', async () => {
  const api = fakeApi({
    links: { [`${LINK.MAL}:1`]: [9] },
    decks: { 9: { mainDeck: { deckId: 9, links: [{ linkType: LINK.MAL, url: 'https://myanimelist.net/manga/1' }] } } },
  });
  const r = await je.checkJiten({ refs: [{ linkType: LINK.MAL, kind: 'anime', id: '1' }], info: info({ main: 'Space Courier' }) }, api);
  assert.equal(r.state, 'none');
  assert.ok(api.calls.some((c) => c[0] === 'search' && c[1] === 'Space Courier'));
});

test('one exact title match of the same type is shown as found', async () => {
  const deck = { deckId: 11, mediaType: MT.ANIME, originalTitle: '星降る夜の物語', englishTitle: 'Night of Falling Stars' };
  const api = fakeApi({
    search: { '星降る夜の物語': [deck, { deckId: 5, mediaType: MT.MANGA, originalTitle: '星降る夜の物語' }] },
    decks: { 11: { mainDeck: { ...deck, characterCount: 10 } } },
  });
  const r = await je.checkJiten({ refs: [{ linkType: LINK.TMDB, kind: 'movie', id: '1234' }],
    info: info({ jp: '星降る夜の物語', main: '星降る夜の物語', english: 'Night of Falling Stars' }) }, api);
  assert.equal(r.state, 'found');
  assert.equal(r.byTitle, true);
  assert.deepEqual(r.decks.map((d) => d.deckId), [11]); // the manga is another type
});

test('an exact title of another type, or two exact titles, stay possible matches', async () => {
  const anime = { deckId: 12, mediaType: MT.ANIME, originalTitle: '風の少女' };
  const drama = { deckId: 13, mediaType: MT.DRAMA, originalTitle: '風の少女' };
  const search = { '風の少女': [anime, drama] };
  const movie = await je.checkJiten({ refs: [{ linkType: LINK.TMDB, kind: 'movie', id: '1' }], info: info({ jp: '風の少女' }, MT.MOVIE) },
    fakeApi({ search }));
  assert.equal(movie.state, 'possible'); // a live-action film isn't the anime or the drama
  const close = await je.checkJiten({ refs: [{ linkType: LINK.TMDB, kind: 'movie', id: '2' }], info: info({ jp: '風の少女 2' }) },
    fakeApi({ search: { '風の少女 2': [anime] } }));
  assert.equal(close.state, 'possible'); // contained, not equal
});

test('a page of unknown type (Bookmeter) lists matches of its types, never shows one as found', async () => {
  const novel = { deckId: 1, mediaType: MT.NONFICTION, originalTitle: '本棚' };
  const anime = { deckId: 2, mediaType: MT.ANIME, originalTitle: '本棚' };
  const api = fakeApi({ search: { '本棚です': [novel, anime] }, decks: { 1: { mainDeck: novel } } });
  const r = await je.checkJiten({ refs: [{ linkType: LINK.BOOKMETER, id: '1' }],
    info: { mediaType: null, siteTypes: [MT.NOVEL, MT.NONFICTION, MT.MANGA], titles: { jp: '本棚です' } } }, api);
  assert.equal(r.state, 'possible'); // contained title only
  const r2 = await je.checkJiten({ refs: [{ linkType: LINK.BOOKMETER, id: '1' }],
    info: { mediaType: null, siteTypes: [MT.NOVEL, MT.NONFICTION, MT.MANGA], titles: { jp: '本棚' } } },
    fakeApi({ search: { '本棚': [novel, anime] }, decks: { 1: { mainDeck: novel } } }));
  assert.equal(r2.state, 'possible'); // exact title, but the page's type is unknown: never shown as found
  assert.deepEqual(r2.matches.map((m) => m.deck.deckId), [1]); // the anime isn't a type Bookmeter lists
});

test('matches are limited to the types the site lists, duplicate-check decks too', async () => {
  const vn = { deckId: 3, mediaType: MT.VN, title: '森の家', isExactMatch: false };
  const film = { deckId: 14, mediaType: MT.MOVIE, originalTitle: '森の家' };
  const novel = { deckId: 15, mediaType: MT.NOVEL, originalTitle: '森の家' };
  const api = { ...fakeApi({ search: { '森の家': [novel, film] }, dup: { existingDecks: [vn], existingRequests: [] } }) };
  const r = await je.checkJiten({ refs: [{ linkType: LINK.BOOKMETER, id: '1', url: 'https://bookmeter.com/books/1' }],
    info: { mediaType: null, siteTypes: [MT.NOVEL, MT.NONFICTION, MT.MANGA], titles: { jp: '森の家' } } }, api);
  assert.deepEqual(r.matches.map((m) => m.deck.deckId), [15]);
});

test('fuzzy hits for a romanized title are dropped ', async () => {
  const hanaIro = { deckId: 16, mediaType: MT.VN, originalTitle: '花色の日々', romajiTitle: 'Hana Iro no Hibi' };
  const kurenaiSora = { deckId: 17, mediaType: MT.VN, originalTitle: '紅の空', romajiTitle: 'Kurenai no Sora' };
  const r = await je.checkJiten({ refs: [{ linkType: LINK.VNDB, id: 'v100' }], info: info({ jp: '紅の花', main: 'Kurenai no Hana' }, MT.VN) },
    fakeApi({ search: { 'Kurenai no Hana': [hanaIro, kurenaiSora] } }));
  assert.equal(r.state, 'none');
  assert.deepEqual(r.matches, []);
});

test('a loose duplicate-check hit is not a possible match', async () => {
  const other = { deckId: 9, mediaType: MT.VN, title: '別の作品', isExactMatch: false };
  const r = await je.checkJiten({ refs: [{ linkType: LINK.VNDB, id: 'v100', url: 'https://vndb.org/v100' }], info: info({ jp: '紅の花', main: 'Kurenai no Hana' }, MT.VN) },
    fakeApi({ dup: { existingDecks: [other], existingRequests: [] } }));
  assert.ok(r.matches.every((m) => m.strength === 0)); // at most a "similar title" from the Japanese query
  const exact = await je.checkJiten({ refs: [{ linkType: LINK.VNDB, id: 'v1', url: 'https://vndb.org/v1' }], info: info({ main: 'Kurenai no Hana' }, MT.VN) },
    fakeApi({ dup: { existingDecks: [{ ...other, isExactMatch: true }], existingRequests: [] } }));
  assert.equal(exact.matches[0].strength, 3); // Jiten's own exact match still counts
});

test('a Japanese query keeps alias hits (ウミノウタ → SEA SONG)', async () => {
  const seaSong = { deckId: 18, mediaType: MT.ANIME, originalTitle: 'SEA SONG' };
  const r = await je.checkJiten({ refs: [{ linkType: LINK.TMDB, kind: 'tv', id: '4321' }], info: info({ jp: 'ウミノウタ' }) },
    fakeApi({ search: { 'ウミノウタ': [seaSong] } }));
  assert.deepEqual(r.matches.map((m) => [m.deck.deckId, m.strength]), [[18, 0]]);
});

test('with an API key, open requests are reported', async () => {
  const api = fakeApi({ dup: { existingDecks: [], existingRequests: [
    { id: 7, title: 'Foo', mediaType: MT.ANIME, status: 1, upvoteCount: 3 },
    { id: 8, title: 'Foo old', mediaType: MT.ANIME, status: 4, upvoteCount: 0 },
  ] } });
  const r = await je.checkJiten({ refs: [{ linkType: LINK.ANILIST, kind: 'anime', id: '5', url: 'https://anilist.co/anime/5' }], info: info({ jp: 'フー' }) }, api);
  assert.equal(r.state, 'requested');
  assert.deepEqual(r.requests.map((q) => q.id), [7]);
  assert.deepEqual(r.closedRequests.map((q) => q.id), [8]);
  assert.equal(r.authoritative, true);
  const dupCall = api.calls.find((c) => c[0] === 'dup')[1];
  assert.deepEqual(dupCall, { title: 'フー', url: 'https://anilist.co/anime/5', mediaType: MT.ANIME });
});

test('with an API key and nothing anywhere: authoritative "none"', async () => {
  const api = fakeApi({ dup: { existingDecks: [], existingRequests: [] } });
  const r = await je.checkJiten({ refs: [{ linkType: LINK.VNDB, id: 'v1', url: 'https://vndb.org/v1' }], info: info({ main: 'Abc' }, MT.VN) }, api);
  assert.equal(r.state, 'none');
  assert.equal(r.authoritative, true);
});

test('a rejected key falls back to the anonymous check; other errors propagate', async () => {
  const e401 = Object.assign(new Error('401'), { status: 401 });
  const r = await je.checkJiten({ refs: [{ linkType: LINK.VNDB, id: 'v1' }], info: info({ main: 'Abc' }) }, fakeApi({ dupError: e401 }));
  assert.equal(r.keyRejected, true);
  assert.equal(r.authoritative, false);
  const down = Object.assign(new Error('down'), { status: 500 });
  await assert.rejects(je.checkJiten({ refs: [{ linkType: LINK.VNDB, id: 'v1' }], info: info({ main: 'Abc' }) }, fakeApi({ dupError: down })));
  const failing = { ...fakeApi(), byLinkId: async () => { throw new Error('offline'); } };
  await assert.rejects(je.checkJiten({ refs: [{ linkType: LINK.VNDB, id: 'v1' }], info: info({}) }, failing));
});

test('VNDB shows character count and reading time by default', () => {
  const vn = { mediaType: MT.VN, characterCount: 626352, uniqueWordCount: 16238, uniqueKanjiCount: 2093, difficultyRaw: 2.86, childrenDeckCount: 2 };
  assert.deepEqual(je.statRows([vn], je.siteDefaults('vndb')).map((r) => r.label), ['Characters', 'Reading time (est.)']);
  assert.ok(je.statRows([vn], je.siteDefaults('anilist')).length > 2);
});

test('dialogue percentage: reading media only, hidden at 0% and 100%', () => {
  const s = { ...je.DEFAULTS, showDialogue: true };
  const labels = (pct) => je.statRows([{ mediaType: MT.VN, dialoguePercentage: pct }], s).map((r) => r.label);
  assert.ok(labels(46.4).includes('Dialogue'));
  assert.ok(!labels(100).includes('Dialogue'));
  assert.ok(!labels(0).includes('Dialogue'));
  const anime = je.statRows([{ mediaType: MT.ANIME, dialoguePercentage: 46.4 }], s).map((r) => r.label);
  assert.ok(!anime.includes('Dialogue'));
});

test('Jiten title in the chosen language, with fallbacks', () => {
  const d = { deckId: 1, originalTitle: '星降る夜の物語', romajiTitle: 'Hoshi Furu Yoru no Monogatari', englishTitle: 'Night of Falling Stars' };
  assert.equal(je.deckTitle(d, 'japanese'), '星降る夜の物語');
  assert.equal(je.deckTitle(d, 'romaji'), 'Hoshi Furu Yoru no Monogatari');
  assert.equal(je.deckTitle(d, 'english'), 'Night of Falling Stars');
  assert.equal(je.deckTitle({ deckId: 2, originalTitle: 'ABC17', romajiTitle: 'ABC17' }, 'english'), 'ABC17');
  assert.equal(je.deckTitle({ deckId: 3 }, 'romaji'), 'Deck 3');
});

test('Bookmeter title without the label', () => {
  assert.equal(je.bookmeterTitle('『剣の国1 はじまりの城』｜感想・レビュー - 読書メーター', '剣の国1 はじまりの城 (電撃文庫)'),
    '剣の国1 はじまりの城');
  assert.equal(je.bookmeterTitle('', '春の憂鬱 (角川スニーカー文庫)'), '春の憂鬱');
  assert.equal(je.bookmeterTitle('', '森の家 上 (講談社文庫) (講談社文庫 む 6-1)'), '森の家 上');
  assert.equal(je.bookmeterTitle('', '小さな灯'), '小さな灯');
});

test('series title drops the volume', () => {
  assert.equal(je.seriesTitle('剣の国1 はじまりの城'), '剣の国');
  assert.equal(je.seriesTitle('森の家 上'), '森の家');
  assert.equal(je.seriesTitle('春の憂鬱'), null);
  assert.equal(je.seriesTitle('42―フォーティツー―'), null);
  assert.equal(je.seriesTitle('魔法の学校 第3巻'), '魔法の学校');
});

test('tab titles and og:titles lose the site\'s additions', () => {
  const cases = {
    'Example Story -the beginning- | vndb': 'Example Story -the beginning-',
    'SEA SONG · AniList': 'SEA SONG',
    'Space Courier (TV 1998) - MyAnimeList.net': 'Space Courier',
    'Night Watch | Manga - MyAnimeList.net': 'Night Watch',
    'Night of Falling Stars (2001) — The Movie Database (TMDB)': 'Night of Falling Stars',
    'Sea Song (TV Series 1999) — The Movie Database (TMDB)': 'Sea Song',
    'Night of Falling Stars (2001) - IMDb': 'Night of Falling Stars',
    'Sea Song (TV Series 1999– ) - IMDb': 'Sea Song',
    '\u200eNight of Falling Stars (2001) directed by Jane Doe • Reviews, film + cast • Letterboxd': 'Night of Falling Stars',
    'Night of Falling Stars (2001)': 'Night of Falling Stars',
    'Star Quest VII (1997) | IGDB.com': 'Star Quest VII',
    'Night City 2049': 'Night City 2049',
    'Gate;Way 0': 'Gate;Way 0',
    '旅人　- 遠い国へ -': '旅人 - 遠い国へ -',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(je.cleanPageTitle(raw), want, raw);
});

test('Amazon links parse to their ASIN', () => {
  assert.deepEqual(je.parseLinkKey(LINK.AMAZON, 'https://www.amazon.co.jp/dp/4048677957?tag=x'), { linkType: LINK.AMAZON, kind: null, id: '4048677957' });
  assert.equal(je.parseLinkKey(LINK.AMAZON, 'https://www.amazon.co.jp/gp/product/B00ABCDEFG/').id, 'b00abcdefg');
});

test('episode/volume counts only for anime, dramas, novels, non-fiction and manga', () => {
  const labels = (mediaType) => je.statRows([{ mediaType, childrenDeckCount: 3, characterCount: 10 }], je.DEFAULTS).map((r) => r.label);
  assert.ok(labels(MT.ANIME).includes('Episodes'));
  assert.ok(labels(MT.MANGA).includes('Volumes'));
  for (const t of [MT.VIDEOGAME, MT.VN, MT.WEBNOVEL, MT.MOVIE]) assert.ok(!labels(t).some((l) => /Episodes|Volumes|Parts/.test(l)), t);
});

test('personal coverage rows and speech speed', () => {
  const on = { ...je.DEFAULTS, showCoverage: true, showUniqueCoverage: true, showSentenceCoverage: true, showSpeechSpeed: true };
  const anime = { mediaType: MT.ANIME, characterCount: 10, speechDuration: 3600e3, speechSpeed: 320.4,
    coverage: 78.3, youngCoverage: 4.1, uniqueCoverage: 52.25, youngUniqueCoverage: 0, readableSentences: 64.7, iPlusOneSentences: 12.2 };
  const rows = Object.fromEntries(je.statRows([anime], on).map((r) => [r.label, r.value]));
  assert.equal(rows.Coverage, '78.3%');
  assert.equal(rows.Unique, '52.3%');
  assert.equal(rows.Sentences, '64%');
  assert.equal(rows['Speech speed'], '320');
  // Anonymous answers: 0 / null, so the rows stay hidden
  const anon = je.statRows([{ ...anime, coverage: 0, youngCoverage: 0, uniqueCoverage: 0, youngUniqueCoverage: 0, readableSentences: null, iPlusOneSentences: null }], on)
    .map((r) => r.label);
  assert.ok(!anon.some((l) => /coverage|sentences/i.test(l)));
  const vn = je.statRows([{ mediaType: MT.VN, characterCount: 10, speechSpeed: 300 }], on).map((r) => r.label);
  assert.ok(!vn.includes('Speech speed'));
});

test('unknown words and Jiten-style bars', () => {
  const on = { ...je.DEFAULTS, showCoverage: true, showSentenceCoverage: true };
  const vn = { mediaType: MT.VN, characterCount: 10, coverage: 78.3, youngCoverage: 4.1,
    readableSentences: 40.2, iPlusOneSentences: 20.5, iPlusTwoSentences: 15.9, iPlusThreeSentences: 23.4 };
  const rows = Object.fromEntries(je.statRows([vn], on).map((r) => [r.label, r]));
  const unknown = (d) => je.statRows([d], { ...on, showUnknownWords: true }).find((r) => r.label === 'Unknown words')?.value;
  assert.equal(unknown({ ...vn, uniqueWordCount: 2000, uniqueCoverage: 60, youngUniqueCoverage: 2 }), '760');
  assert.equal(unknown({ ...vn, uniqueWordCount: 2000, uniqueCoverage: 0, youngUniqueCoverage: 0 }), undefined); // no key: 0
  assert.equal(rows.Coverage.bar.solid, 78.3);
  assert.equal(rows.Sentences.bar.color, 'sentences');
  assert.equal(je.statRows([{ ...vn, wordCount: 1000 }], on).find((r) => r.label === 'Coverage').bar.title,
    'Mature: 783 / 1000 (78.3%)\nYoung: 41 / 1000 (4.1%)\nTotal: 82.4%');
  assert.equal(rows.Sentences.bar.title,
    'Sentences you understand\n40% with every word known\n60% with at most one new word\ni+1 20% · i+2 15% · i+3+ 23%');
  assert.equal(je.statRows([vn], { ...on, coverageBars: false }).find((r) => r.label === 'Coverage').bar, undefined);
  assert.equal(rows.Coverage.hint, 'Words of this work you know (lighter bar: ones you\'re learning)');
  assert.equal(je.statRows([vn], { ...on, coverageBars: false }).find((r) => r.label === 'Coverage').hint, 'Words of this work you know');
  assert.equal(je.statRows([vn, vn], on).find((r) => r.label === 'Coverage').bar, undefined); // several releases: no bar
});

test('stat order: default puts coverage under characters; saved orders gain new stats in place', () => {
  assert.deepEqual(je.STAT_KEYS.slice(0, 7), ['showStatus', 'showProgress', 'showCharacters', 'showCoverage', 'showUniqueCoverage', 'showUnknownWords', 'showSentenceCoverage']);
  const saved = je.STAT_KEYS.filter((k) => k !== 'showSpeechSpeed').reverse();
  const merged = je.statOrder(saved);
  assert.equal(merged.length, je.STAT_KEYS.length);
  assert.equal(merged.indexOf('showSpeechSpeed'), merged.indexOf('showSpeech') + 1); // after its default predecessor
  const vn = { mediaType: MT.VN, characterCount: 626352, difficultyRaw: 2.86, uniqueWordCount: 5 };
  const rows = je.statRows([vn], { ...je.DEFAULTS, statOrder: ['showDifficulty', 'showUniqueWords', 'showCharacters'] }).map((r) => r.label);
  assert.deepEqual(rows.slice(0, 3), ['Difficulty', 'Unique words', 'Characters']);
});

test('Jiten status row: on by default, shown whenever a key is set', () => {
  const deck = { mediaType: MT.VN, characterCount: 10 };
  const keyed = { ...je.DEFAULTS, apiKey: 'k' };
  assert.equal(je.statRows([{ ...deck, status: 2 }], keyed)[0].label, 'Jiten status');
  assert.ok(je.statRows([{ ...deck, status: null }], { ...je.siteDefaults('vndb'), apiKey: 'k' }).some((r) => r.status)); // never touched: not in list
  assert.ok(!je.statRows([{ ...deck, status: 2 }], je.DEFAULTS).some((r) => r.status)); // no key
  assert.ok(je.statRows([{ ...deck, status: 2 }, { ...deck, status: 1 }], keyed).some((r) => r.status)); // several releases: one each
});

test('request title prefers Japanese', () => {
  assert.equal(je.requestTitle({ titles: { jp: 'ウミノウタ', main: 'SEA SONG' } }), 'ウミノウタ');
  assert.equal(je.requestTitle({ titles: { main: 'ABC17' } }), 'ABC17');
});

test('status dates use the local calendar day', () => {
  assert.equal(je.localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(je.localDate(new Date(2026, 11, 31, 0, 1)), '2026-12-31');
});

test('main title before a subtitle', () => {
  assert.equal(je.mainTitlePart('Star Song: Second Verse'), 'Star Song');
  assert.equal(je.mainTitlePart('星の歌 ～第二章～'), '星の歌');
  assert.equal(je.mainTitlePart('Star Song - Second Verse'), 'Star Song');
  assert.equal(je.mainTitlePart('Re:Something'), null); // too short to search on
  assert.equal(je.mainTitlePart('Star Song'), null);
});

test('another version under the main title is only a similar title, never this work', async () => {
  const other = { deckId: 31, mediaType: MT.VN, originalTitle: 'Star Song ~First Verse~' };
  const same = { deckId: 32, mediaType: MT.VN, originalTitle: 'Star Song' };
  const api = fakeApi({ search: { 'Star Song': [other, same] } });
  const r = await je.checkJiten({ refs: [{ linkType: LINK.IGDB, id: 'star-song-second-verse' }], info: info({ main: 'Star Song: Second Verse' }, MT.VN) }, api);
  assert.equal(r.state, 'possible');
  assert.deepEqual(r.matches.map((m) => [m.deck.deckId, m.strength]), [[31, 1], [32, 1]]);
});

test('progress row from the list entry', () => {
  const on = { ...je.DEFAULTS, showProgress: true };
  const progress = (d) => je.statRows([d], on).find((r) => r.label === 'Progress')?.value;
  const novel = { mediaType: MT.NOVEL, characterCount: 1000 };
  assert.equal(progress({ ...novel, listEntry: { state: 0, charactersRead: 340, completedCount: 0 } }), '34%');
  assert.equal(progress({ ...novel, listEntry: { state: 0, unitCount: 12, completedUnits: 4, completedCount: 1 } }), '4 of 12 volumes · Read once');
  assert.equal(progress({ mediaType: MT.ANIME, characterCount: 10, listEntry: { state: 1, completedCount: 2 } }), 'Watched twice');
  assert.equal(progress({ ...novel, listEntry: { state: 0, charactersRead: 0, completedCount: 0 } }), undefined);
  assert.equal(progress({ mediaType: MT.VN, characterCount: 556628, listEntry: { state: 0, charactersRead: 356242, completedCount: 0 } }), '64% (356,242)');
  assert.equal(progress(novel), undefined); // no key: no list entry
});
