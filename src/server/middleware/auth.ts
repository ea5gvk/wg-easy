export default defineEventHandler(async (event) => {
  const url = getRequestURL(event);
  const session = await useWGSession(event);
  if (url.pathname === '/login') {
    if (!REQUIRES_PASSWORD || session.data.authenticated) {
      return sendRedirect(event, '/', 302);
    }
  }
  if (url.pathname === '/') {
    if (!session.data.authenticated && REQUIRES_PASSWORD) {
      return sendRedirect(event, '/login', 302);
    }
  }
});
