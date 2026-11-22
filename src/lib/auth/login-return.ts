/** Only protected app destinations; never external URLs or auth/signout loops. */
export function loginReturnPath(value: unknown): string {
  const unsafe = (text: string) => [...text].some(c => c === '\\' || c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
  if (typeof value !== 'string' || unsafe(value) || value.startsWith('//')) return '/dashboard'
  try {
    const url = new URL(value, 'https://app.invalid')
    if (url.origin !== 'https://app.invalid' || !value.startsWith('/')) return '/dashboard'
    // Reject encoded separators/control characters before URL normalisation.
    const decoded = decodeURIComponent(value)
    if (unsafe(decoded) || decoded.startsWith('//')) return '/dashboard'
    if (!['/dashboard', '/properties'].some(p => url.pathname === p || url.pathname.startsWith(`${p}/`))) return '/dashboard'
    return `${url.pathname}${url.search}${url.hash}`
  } catch { return '/dashboard' }
}
