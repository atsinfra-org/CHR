// Browser-only loaders for the PDF font and logo. Imported only when an export runs, so the main site never loads them.
import regularUrl from "./fonts/NotoSans-Regular.subset.ttf?url";
import boldUrl from "./fonts/NotoSans-Bold.subset.ttf?url";

const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const fetchBase64 = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("FONT_LOAD_FAILED");
  return toBase64(await res.arrayBuffer());
};

/** The embedded Noto Sans subset (Latin + the rupee sign). Both weights are required: a failed load stops the PDF. */
export async function loadPdfFonts() {
  const [regular, bold] = await Promise.all([fetchBase64(regularUrl), fetchBase64(boldUrl)]);
  return { regular, bold };
}

/** The club logo as a data URL, or null if it can't be loaded (the PDF is simply made without it). */
export async function loadLogo() {
  try {
    const res = await fetch("/assests/chr-logo-120.png");
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
