export const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id)! as T;

export const input = (id: string) => element<HTMLInputElement>(id);

export function text(id: string, value: string): void {
  const target = element(id);
  if (target.textContent !== value) target.textContent = value;
}

export function pressed(id: string, value: boolean): void {
  element(id).setAttribute("aria-pressed", String(value));
}
