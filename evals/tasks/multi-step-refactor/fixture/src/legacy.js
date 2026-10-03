// Legacy monolith: one big function doing parse + validate + format.
export function process(input) {
  // --- parse ---
  const raw = String(input).trim();
  if (raw === "") {
    return "EMPTY";
  }
  const parts = raw.split("|");
  const name = parts[0];
  const ageStr = parts[1];
  // --- validate ---
  if (!name) {
    return "INVALID:missing-name";
  }
  const age = Number(ageStr);
  if (Number.isNaN(age)) {
    return "INVALID:bad-age";
  }
  if (age < 0) {
    return "INVALID:negative-age";
  }
  if (age > 150) {
    return "INVALID:age-too-large";
  }
  // --- format ---
  const label = name.length > 10 ? name.slice(0, 10) + ".." : name;
  const bucket = age < 18 ? "minor" : age < 65 ? "adult" : "senior";
  return label + ":" + bucket;
}
