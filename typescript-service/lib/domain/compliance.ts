const blocked = ["guaranteed", "proven", "miracle", "cure", "treatment", "prescription", "trt", "hgh",
  "semaglutide", "ozempic", "tirzepatide", "life-changing", "revolutionary"];

// Campaign checks only; passing these checks is not approval to send.
export function checkMessage(text: string, maxWords = 100) {
  if (!Number.isInteger(maxWords) || maxWords < 1 || maxWords > 100) throw new Error("Invalid word limit");
  const violations: string[] = [];
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (!words) violations.push("empty_message");
  if (words > maxWords) violations.push("word_count_exceeded");
  const lower = text.toLowerCase();
  for (const term of blocked) if (lower.includes(term)) violations.push(`blocked_word:${term}`);
  if (/https?:\/\//i.test(text)) violations.push("contains_link");
  // Preserve the legacy conservative UTF-16 count until campaign wording is approved.
  const emojiUnits = text.split("").filter((character) => character.charCodeAt(0) > 8000).length;
  if (emojiUnits > 2) violations.push("excessive_emojis");
  return { compliant: violations.length === 0, wordCount: words, violations };
}

