(async ()=>{
  const spinner = document.getElementById('apod-spinner');
  const body    = document.getElementById('apod-body');
  const imgEl   = document.getElementById('apod-img');

  try {
    const res = await fetch('php/apod-proxy.php');
    if(!res.ok) throw new Error(res.status);
    const d = await res.json();

    document.getElementById('apod-title').textContent   = d.title;
    document.getElementById('apod-date').textContent    = new Date(d.date).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
    document.getElementById('apod-explain').textContent = d.explanation;
    document.getElementById('apod-link').href           = `https://apod.nasa.gov/apod/ap${d.date.replace(/-/g,'').slice(2)}.html`;

    if(d.copyright) {
      document.getElementById('apod-copy').textContent = `© ${d.copyright}`;
    } else {
      document.getElementById('apod-copy').textContent = '';
    }

    imgEl.src = d.url;
    imgEl.alt = d.title;
    imgEl.title = d.title;
    imgEl.addEventListener('click', () => window.open(d.hdurl || d.url, '_blank'));
    
    spinner.hidden = true;
    body.hidden    = false;
  }catch(e){
    spinner.hidden = true;
    body.hidden    = false;
    body.innerHTML = `<p style="text-align:center;color:var(--error)">Unable to load picture.</p>`;
  }
})();