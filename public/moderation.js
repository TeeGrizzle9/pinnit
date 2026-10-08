// Pinnit language filter, shared by the app (instant feedback) and the Worker (enforced on save).
//
// Blocks strong profanity, slurs and sexual content, including common disguises
// ("f.u.c.k", "fuuuck", "5h1t"). Mild words (damn, hell, crap, bloody) are allowed.
// Whole-word matching avoids blocking innocent words like "cocktail", "Scunthorpe" or "circumstance".
// The server also runs an AI safety check for things a word list can't catch.

// matched anywhere inside a word (they never occur inside innocent words)
const ANYWHERE = ['fuck', 'nigger', 'nigga', 'faggot', 'wanker', 'wanking', 'blowjob', 'handjob', 'dildo',
  'porn', 'asshole', 'arsehole', 'bullshit', 'dickhead', 'cocksuck', 'jizz', 'onlyfans', 'nudes', 'pussies', 'titties'];
// matched as whole words only (with common endings like -s, -ing, -ed)
const WHOLE = ['cunt', 'cunty', 'shit', 'shitty', 'shite', 'cum', 'cumming', 'cock', 'prick', 'bitch', 'bastard', 'slut', 'whore', 'pussy',
  'tits', 'boobs', 'nude', 'naked', 'horny', 'sexy', 'sexting', 'nsfw', 'anal', 'orgasm', 'erotic', 'fetish', 'bdsm',
  'threesome', 'milf', 'rape', 'rapist', 'raping', 'kys', 'retard', 'retarded', 'tranny', 'chink', 'spic', 'kike', 'dyke', 'fag',
  'twat', 'wank', 'bollocks', 'arse', 'ass', 'skank', 'thot', 'incel', 'deepthroat', 'creampie', 'cumshot', 'sext', 'xxx'];
// phrases (spaces are flexible)
const PHRASES = ['send nudes', 'come over to mine', 'netflix and chill', 'kill yourself', 'f off', 'go die'];

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '€': 'e' };
function normalise(text) {
  return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[0134578@$!|+€]/g, c => LEET[c]);
}
// each letter may repeat ("fuuuck") and be split by one non-letter ("f.u.c.k", "f u c k")
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const letters = w => [...w].map(c => c === ' ' ? '[^a-z]+' : esc(c) + '+').join('[^a-z]?');
const ENDINGS = '(?:s|es|ed|er|ers|ing|in|y)?';
const RE_ANY = new RegExp(ANYWHERE.map(letters).join('|'));
const RE_WHOLE = new RegExp('(?:^|[^a-z])(?:' + WHOLE.map(letters).join('|') + ')' + ENDINGS + '(?![a-z])');
const RE_PHRASE = new RegExp('(?:^|[^a-z])(?:' + PHRASES.map(letters).join('|') + ')(?![a-z])');

// returns null when fine, or a short label for the log
export function findBadLanguage(text) {
  const t = normalise(text);
  if (!t.trim()) return null;
  const m = RE_ANY.exec(t) || RE_WHOLE.exec(t) || RE_PHRASE.exec(t);
  return m ? m[0].trim() : null;
}

export function languageMessage(what = 'This', verb = 'posted') {
  return `${what} wasn't ${verb} because it may contain offensive or sexual language. Pinnit is a safe and welcoming space for everyone, so please rephrase it and try again.`;
}
