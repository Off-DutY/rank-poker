import './ui/style.css';
import { cryptoRng } from './core/cards';
import { cleanName } from './core/engine';
import { ClientSession, HostSession } from './net/session';
import { realClock } from './net/transport';
import { trysteroTransport } from './net/trystero';
import { mountGame } from './ui/app';
import { esc } from './ui/render';
import { markHost, newRoomCode, parseRoomCode, playerId, saveName, savedName, wasHost } from './ui/room';

const app = document.getElementById('app')!;
const code = parseRoomCode(location.hash);

// A different room code in the URL means a different game. Start over.
window.addEventListener('hashchange', () => location.reload());

const RULES_TEXT = `<details class="rules"><summary>遊戲規則</summary><ol>
  <li>3–13 人合作。牌力依德州撲克規則，用 2 張手牌 + 5 張公牌中最好的 5 張比大小。</li>
  <li>不能透露自己的手牌。</li>
  <li>每輪 20 秒內選順位並鎖定：1 是最小，最大等於人數。</li>
  <li>多人選同一個順位時，用執著度決定誰留下，其他人移到最近的空順位。</li>
  <li>之後是交換階段：可以向別人提出互換順位，被拒絕時可以挑戰（預算制）。</li>
  <li>發牌順序：手牌 → 3 張公牌 → 第 4 張 → 第 5 張，每次都重新選順位。</li>
  <li>最後順位和真實牌力順序一致就算成功。先 3 勝或 3 敗結束。</li>
  <li>特殊玩法（房主在大廳設定）：手牌改為 3 張；或跳過第 1–3 輪中的 1 輪，該輪的牌併入下一輪一起發。</li>
  <li>注意：房主的瀏覽器負責發牌，技術上可以看到所有手牌。</li>
</ol></details>`;

function nameForm(title: string, button: string, onSubmit: (name: string) => void): void {
  app.innerHTML = `<section class="panel home">
    <h1>排名撲克</h1>
    <p class="hint">${title}</p>
    <form><input name="name" maxlength="12" placeholder="你的暱稱" required value="${esc(savedName())}">
    <button class="primary big">${button}</button></form>
    ${RULES_TEXT}</section>`;
  app.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = cleanName((app.querySelector('input') as HTMLInputElement).value);
    saveName(name);
    onSubmit(name);
  });
}

if (!code) {
  nameForm('建立房間後，把連結分享給其他玩家。', '建立房間', (name) => {
    const room = newRoomCode();
    markHost(room);
    history.replaceState(null, '', `#${room}`);
    mountGame(app, new HostSession(playerId(), name, trysteroTransport(room), realClock, cryptoRng), room);
  });
} else if (wasHost(code)) {
  app.innerHTML = `<section class="panel message"><h2>房間已結束</h2>
    <p>你是房間 ${code} 的房主。重新整理後房主狀態無法保留，這個房間已結束。</p>
    <a class="button primary" href="${location.pathname}">建立新房間</a></section>`;
} else {
  nameForm(`加入房間 ${code}`, '加入房間', (name) => {
    mountGame(app, new ClientSession(playerId(), name, trysteroTransport(code), realClock), code);
  });
}
