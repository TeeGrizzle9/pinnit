// Pinnit language filter, shared by the app (instant feedback) and the Worker (enforced on save).
//
// Blocks profanity, slurs, insults and sexual content, including common disguises
// ("f.u.c.k", "fuuuck", "5h1t", "0rgy"). Mild words (damn, hell, crap, bloody, bugger) are allowed.
// Whole-word matching avoids blocking innocent words like "cocktail", "Scunthorpe", "breaststroke"
// or "circumstance". The server also runs two AI checks for things a word list can't catch.
// To block another word: add it to the right list below and push. Test it against innocent phrases first.

// matched anywhere inside a word (they never occur inside innocent words)
const ANYWHERE = [
  // profanity
  'fuck', 'motherfuck', 'wanker', 'wanking', 'bullshit', 'shithead', 'dickhead', 'knobhead', 'cocksuck', 'douchebag', 'jackass', 'dumbass', 'fatass', 'asshole', 'arsehole', 'tosser', 'bellend',
  // slurs
  'nigger', 'nigga', 'faggot', 'poofter', 'towelhead', 'raghead', 'shemale',
  // sexual
  'blowjob', 'handjob', 'rimjob', 'footjob', 'dildo', 'vibrator', 'porn', 'jizz', 'onlyfans', 'nudes', 'pussies', 'titties', 'boobies',
  'gangbang', 'bukkake', 'masturbat', 'ejaculat', 'sodomi', 'paedophil', 'pedophil', 'hentai', 'camgirl', 'bestiality', 'cumdump', 'buttplug', 'strapon'
];
// matched as whole words only (with common endings like -s, -ing, -ed)
const WHOLE = [
  // profanity and insults
  'cunt', 'cunty', 'shit', 'shitty', 'shite', 'shat', 'prick', 'bitch', 'bastard', 'twat', 'wank', 'bollocks', 'arse', 'ass', 'skank', 'slag',
  'douche', 'scumbag', 'spunk', 'retard', 'retarded', 'spastic', 'spaz', 'mong', 'kys', 'incel', 'thot',
  // slurs
  'tranny', 'chink', 'spic', 'kike', 'dyke', 'fag', 'coon', 'abo', 'gook', 'paki', 'lezzo', 'lesbo', 'wetback',
  // sexual
  'cum', 'cumming', 'cumshot', 'cock', 'pussy', 'tits', 'titty', 'boobs', 'boob', 'nude', 'nudes', 'nudist', 'naked', 'horny', 'sexy', 'sexting', 'sext',
  'nsfw', 'anal', 'orgasm', 'orgy', 'orgies', 'erotic', 'erotica', 'fetish', 'kinky', 'bdsm', 'threesome', 'foursome', 'milf', 'dilf', 'gilf',
  'deepthroat', 'creampie', 'xxx', 'penis', 'vagina', 'vulva', 'clitoris', 'clit', 'testicles', 'scrotum', 'genitals', 'erection', 'boner',
  'shag', 'shagging', 'shagged', 'fap', 'fapping', 'jerkoff', 'grope', 'groping', 'fondle', 'fondling', 'molest', 'molester',
  'paedo', 'pedo', 'incest', 'hooker', 'prostitute', 'stripper', 'lapdance', 'escorts', 'dtf', 'fwb', 'nipple', 'nipples',
  'seduce', 'seductive', 'slutty', 'whore', 'slut', 'rape', 'rapist', 'raping', 'raped', 'sexual', 'sexually', 'sex'
];
// phrases (spaces are flexible)
const PHRASES = [
  'send nudes', 'come over to mine', 'back to mine', 'back to my place', 'my place after', 'netflix and chill',
  'booty call', 'friends with benefits', 'sugar daddy', 'sugar baby', 'one night stand', 'get laid', 'getting laid',
  'jerk off', 'jack off', 'blow me', 'suck my', 'lap dance', 'strip club',
  'kill yourself', 'f off', 'go die', 'piss off', 'shut up bitch', 'get raped'
];
// the plain word "sex" and "bang" have innocent uses; let these through
const ALLOW = ['mixed sex', 'same sex', 'single sex', 'sex discrimination', 'sexual health', 'sex education', 'cock and bull', 'cock n bull'];

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '€': 'e' };
function normalise(text) {
  return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[0134578@$!|+€]/g, c => LEET[c]);
}
// each letter may repeat ("fuuuck") and be split by one non-letter ("f.u.c.k", "f u c k")
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const letters = w => [...w].map(c => c === ' ' ? '[^a-z]+' : esc(c) + '+').join('[^a-z]?');
const ENDINGS = '(?:s|es|ed|er|ers|ing|in|y|ie|ies)?';
const RE_ANY = new RegExp(ANYWHERE.map(letters).join('|'));
const RE_WHOLE = new RegExp('(?:^|[^a-z])(?:' + WHOLE.map(letters).join('|') + ')' + ENDINGS + '(?![a-z])');
const RE_PHRASE = new RegExp('(?:^|[^a-z])(?:' + PHRASES.map(letters).join('|') + ')(?![a-z])');
const RE_ALLOW = new RegExp('(?:^|[^a-z])(?:' + ALLOW.map(w => w.replace(' ', '[^a-z]+')).join('|') + ')(?![a-z])', 'g');

// returns null when fine, or the matched text (for the log)
export function findBadLanguage(text) {
  const t = normalise(text).replace(RE_ALLOW, ' ');
  if (!t.trim()) return null;
  const m = RE_ANY.exec(t) || RE_WHOLE.exec(t) || RE_PHRASE.exec(t);
  return m ? m[0].trim() : null;
}

export function languageMessage(what = 'This', verb = 'posted') {
  return `${what} wasn't ${verb} because it may contain offensive or sexual language. Pinnit is a safe and welcoming space for everyone, so please rephrase it and try again.`;
}
