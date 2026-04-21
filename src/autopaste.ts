/**
 * Optional auto-paste via @nut-tree-fork/nut-js. The dependency is optional so
 * the app still runs on systems where the native module fails to install.
 */
export async function sendPasteKeystroke(): Promise<void> {
  try {
    const nut = await import('@nut-tree-fork/nut-js');
    const { keyboard, Key } = nut;
    await keyboard.pressKey(Key.LeftControl, Key.V);
    await keyboard.releaseKey(Key.LeftControl, Key.V);
  } catch (err) {
    console.warn('[autopaste] nut-js unavailable, skipping paste:', err);
  }
}
