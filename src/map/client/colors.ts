const palette = [
  ['#6848cb', '#c1a9ff'],
  ['#08766c', '#65d9c5'],
  ['#a64c11', '#ffb781'],
  ['#245bb3', '#93bfff'],
  ['#a73f77', '#f4a3d2'],
  ['#65750b', '#d2df78'],
  ['#b44543', '#ffaaa7'],
  ['#087b9c', '#85d6f1'],
  ['#8b5105', '#e8c37c'],
  ['#227244', '#97d9aa'],
  ['#4c3d94', '#b5aafb'],
  ['#983253', '#f996b1'],
  ['#365978', '#a8cce5'],
  ['#746214', '#e1cc70'],
  ['#855425', '#ddba90'],
  ['#4b702e', '#b6d893'],
  ['#a63f24', '#f4a38a'],
  ['#814093', '#e0abf3'],
] as const;

export class ParticipantColors {
  private readonly slots = new Map<string, number>();

  register(ids: Iterable<string>): void {
    for (const id of [...new Set(ids)].sort()) {
      if (!this.slots.has(id)) this.slots.set(id, this.slots.size);
    }
  }

  color(id: string, dark: boolean): string {
    if (!this.slots.has(id)) this.slots.set(id, this.slots.size);
    const slot = this.slots.get(id)!;
    const pair = palette[slot];
    if (pair) return pair[dark ? 1 : 0];
    const index = slot - palette.length;
    const hue = ((index * 137.508 + 24) % 360).toFixed(3);
    const saturation = index % 2 ? 74 : 59;
    const lightness = dark ? 68 + 5 * (index % 3) : 37 + 4 * (index % 3);
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  }
}
