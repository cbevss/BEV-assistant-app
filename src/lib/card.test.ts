import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
import { cardBrand, expiryAs, findCard, luhnOk, openCard, sealCard, validateCard, type SavedCard } from "./card";

const card = { number: "4242 4242 4242 4242", name: "Callum", expiry: "08/29", cvc: "123" };

describe("card vault", () => {
  it("encrypts so the number isn't readable, and opens with the right password", async () => {
    const s = await sealCard(card, "hunter22");
    expect(JSON.stringify(s)).not.toContain("4242424242424242");
    expect(s.last4).toBe("4242");
    expect(s.brand).toBe("Visa");
    const back = await openCard(s, "hunter22");
    expect(back.number).toBe("4242424242424242");
    expect(back.cvc).toBe("123");
  }, 30_000);
  it("refuses the wrong password", async () => {
    const s = await sealCard(card, "hunter22");
    await expect(openCard(s, "hunter23")).rejects.toThrow(/wrong password/i);
  }, 30_000);
  it("needs a long enough password", async () => {
    await expect(sealCard(card, "abc")).rejects.toThrow(/at least/);
  });
  it("validates details", () => {
    expect(luhnOk("4242424242424242")).toBe(true);
    expect(luhnOk("4242424242424241")).toBe(false);
    expect(validateCard(card)).toEqual([]);
    expect(validateCard({ ...card, expiry: "13/29" }).length).toBe(1);
    expect(cardBrand("5555555555554444")).toBe("Mastercard");
  });
  it("splits the expiry for forms", () => {
    expect(expiryAs("08/29", "month")).toBe("08");
    expect(expiryAs("08/29", "year4")).toBe("2029");
    expect(expiryAs("08/29", "full")).toBe("08/29");
  });
});

describe("picking a card", () => {
  const mk = (nickname: string, brand: string, last4: string) => ({ id: nickname, nickname, brand, last4 }) as SavedCard;
  const cards = [mk("Monzo", "Mastercard", "4444"), mk("Work card", "Visa", "4242"), mk("Amex", "Amex", "0005")];
  it("finds by nickname, part of it, or last 4 digits", () => {
    expect(findCard(cards, "monzo")?.id).toBe("Monzo");
    expect(findCard(cards, "my work card")?.id).toBe("Work card");
    expect(findCard(cards, "4242")?.id).toBe("Work card");
    expect(findCard(cards, "ending 0005")?.id).toBe("Amex");
    expect(findCard(cards, "visa")?.id).toBe("Work card");
    expect(findCard(cards, "barclays")).toBeNull();
  });
});
