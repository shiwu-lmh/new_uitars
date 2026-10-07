// Node 24 can return ENOMEM for os.userInfo() in some restricted Windows
// environments. Electron's file-store dependency only needs uid/gid defaults.
const os = require('node:os');
const originalUserInfo = os.userInfo.bind(os);

os.userInfo = function userInfoWithFallback() {
  try {
    return originalUserInfo();
  } catch (error) {
    if (error && error.info?.code !== 'ENOMEM') throw error;
    const username = process.env.USERNAME || 'Administrator';
    return { username, uid: username, gid: username, shell: null, homedir: os.homedir() };
  }
};
