// Relevance filter for Avito knife listings.
//
// Wanted: Soviet folding, hunting and military knives, plus knife keychains.
// Not wanted: kitchen/table knives, books, industrial tooling.

const RE_BLADE = /нож(?!ниц|овк|к)|клинок|кинжал|кортик|штык|тесак|палаш|сабл/i;
const RE_KEYCHAIN = /брелок|keychain/i;
const RE_TYPE = /складн|перочин|охотнич|военн|армейск|военохот|десант|спецназ|морск|флот|казач/i;
const RE_SOVIET = /ссср|советск|cccp/i;
const RE_EXCLUDE = /кухонн|мясн|повар|разделочн|столов|сервиз|сервировочн|вилк|ложк|мясорубк|терк|кастрюл|сковород|консервн|сечка|капуст|посуда|мельхиор|нейзильбер|хлеб|фотобумаг|книг|роман|журнал|энциклопед|справочник|учебник|плакат|открытк|рубанок|фрез|резец|сверл|станок|шлифмотор|точило|промышлен|напильник|зубило|стамеск|долот|молоток|секатор|топор|лопат|пила|ножовк|ножниц|ножк|бритв|канцеляр|садов|грибник|строительн|монтажн|хозяйствен/i;

export function isRelevant(item) {
  const title = String(item.title || "").toLowerCase();
  const text = `${title} ${String(item.description || "").toLowerCase()}`;

  const hasBlade = RE_BLADE.test(title);
  const hasKeychainKnife = RE_KEYCHAIN.test(title) && (RE_BLADE.test(text) || RE_TYPE.test(text));
  if (!hasBlade && !hasKeychainKnife) return false;

  // Keep only items that actually mention the USSR / Soviet origin.
  if (!RE_SOVIET.test(text)) return false;

  if (RE_EXCLUDE.test(title)) return false;

  // "Набор ножей" is usually a table set; keep sets that are clearly knives
  // we want (folding/hunting/military).
  if (/набор/.test(text) && /нож/.test(text) && !RE_TYPE.test(text)) return false;

  return true;
}
