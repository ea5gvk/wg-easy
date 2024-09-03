export default defineEventHandler(async (event) => {
  const url = getRequestURL(event);
  if (
    !REQUIRES_PASSWORD ||
    !url.pathname.startsWith('/api/') ||
    url.pathname === '/api/session' ||
    url.pathname === '/api/lang' ||
    url.pathname === '/api/release' ||
    url.pathname === '/api/ui-chart-type' ||
    url.pathname === '/api/ui-traffic-stats'
  ) {
    return;
  }
  const session = await getSession(event, SESSION_CONFIG);
  if (session.id && session.data.authenticated) {
    return;
  }

  const authorization = getHeader(event, 'Authorization');
  if (url.pathname.startsWith('/api/') && authorization) {
    if (isPasswordValid(authorization, PASSWORD_HASH)) {
      return;
    }
    throw createError({
      statusCode: 401,
      statusMessage: 'Incorrect Password',
    });
  }

  throw createError({
    statusCode: 401,
    statusMessage: 'Not logged in',
  });
});
