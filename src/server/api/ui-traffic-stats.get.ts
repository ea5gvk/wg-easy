export default defineEventHandler((event) => {
  setHeader(event, 'Content-Type', 'application/json');
  return UI_TRAFFIC_STATS === 'true' ? true : false;
});
