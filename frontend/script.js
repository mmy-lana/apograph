// Animate fidelity bars to their data-width on page load.
(function () {
  'use strict';

  var installBtn = document.getElementById('install-btn');
  var installCmd = document.getElementById('install-cmd');
  if (installBtn && installCmd) {
    installBtn.addEventListener('click', function () {
      var hidden = installCmd.classList.toggle('hidden');
      installCmd.setAttribute('aria-hidden', hidden ? 'true' : 'false');
      installBtn.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    });
  }

  function fillBars() {
    var bars = document.querySelectorAll('.fidelity-bar[data-width]');
    for (var i = 0; i < bars.length; i++) {
      var bar = bars[i];
      bar.style.width = bar.getAttribute('data-width') + '%';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fillBars);
  } else {
    fillBars();
  }
})();
