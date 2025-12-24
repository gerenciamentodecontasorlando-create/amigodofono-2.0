/* BTX AudioLaudo — app.js
   - Tabela dinâmica OD/OE
   - Audiograma em tempo real (canvas)
   - Frequências completas (inclui 3k, 5k, 7k)
   - PTA automático (500/1k/2k)
   - Sugestão de interpretação (editável)
   - PDF com imagem do audiograma
   - Persistência local (localStorage)
   - Agenda offline + PDF do dia + carregar paciente no audiograma
*/

const FREQS = [250, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
const DB_MIN = -10;
const DB_MAX = 120;

const STORAGE_KEY = "btx_audiolaudo_v2";
const AGENDA_KEY  = "btx_audiolaudo_agenda_v1";

const state = {
  paciente: "",
  data: "",
  OD: {},
  OE: {},
  interpretacao: ""
};

const agendaState = {
  items: [] // {id, data, hora, paciente, tipo, fone, obs}
};

let canvas, ctx;

function $(id){ return document.getElementById(id); }
function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }

function parseDb(v){
  const s = String(v ?? "").trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return clamp(n, DB_MIN, DB_MAX);
}

function todayISO(){
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

function uuid(){
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/* ===== Tabs ===== */
function wireTabs(){
  const tabs = Array.from(document.querySelectorAll(".tab"));
  tabs.forEach(btn=>{
    btn.addEventListener("click", ()=>{
      tabs.forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");

      const id = btn.dataset.tab;
      document.querySelectorAll(".panel").forEach(p=>p.classList.remove("active"));
      document.getElementById(id).classList.add("active");

      if(id === "tab-audio") drawAudiogram();
      if(id === "tab-agenda") renderAgenda();
    });
  });
}

/* ===== Persistência Laudo ===== */

function saveLocal(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }catch(e){}
}

function loadLocal(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return;
    const obj = JSON.parse(raw);
    if(!obj || typeof obj !== "object") return;

    state.paciente = obj.paciente ?? "";
    state.data = obj.data ?? "";
    state.interpretacao = obj.interpretacao ?? "";

    state.OD = obj.OD ?? {};
    state.OE = obj.OE ?? {};

    for(const f of FREQS){
      if(!(f in state.OD)) state.OD[f] = null;
      if(!(f in state.OE)) state.OE[f] = null;
    }
  }catch(e){}
}

function clearAll(){
  state.paciente = "";
  state.data = todayISO();
  state.interpretacao = "";
  for(const f of FREQS){
    state.OD[f] = null;
    state.OE[f] = null;
  }
  saveLocal();
  renderAll();
}

/* ===== Persistência Agenda ===== */

function saveAgenda(){
  try{
    localStorage.setItem(AGENDA_KEY, JSON.stringify(agendaState));
  }catch(e){}
}

function loadAgenda(){
  try{
    const raw = localStorage.getItem(AGENDA_KEY);
    if(!raw) return;
    const obj = JSON.parse(raw);
    if(!obj || typeof obj !== "object") return;
    agendaState.items = Array.isArray(obj.items) ? obj.items : [];
  }catch(e){}
}

function normalizePhone(s){
  const raw = String(s || "").trim();
  return raw.replace(/[^\d]/g, "");
}

function agendaForDay(dateISO){
  return agendaState.items
    .filter(it => it.data === dateISO)
    .sort((a,b)=> (a.hora || "").localeCompare(b.hora || ""));
}

/* ===== Cálculos ===== */

function computePTA(ear){
  const freqs = [500, 1000, 2000];
  const vals = freqs.map(f => state[ear][f]).filter(v => Number.isFinite(v));
  if(vals.length === 0) return null;
  const avg = vals.reduce((a,b)=>a+b,0) / vals.length;
  return Math.round(avg);
}

function classifyPTA(pta){
  if(pta === null) return "—";
  if(pta <= 25) return "Normal";
  if(pta <= 40) return "Leve";
  if(pta <= 55) return "Moderada";
  if(pta <= 70) return "Moderadamente severa";
  if(pta <= 90) return "Severa";
  return "Profunda";
}

function asymmetryNote(){
  let count = 0;
  for(const f of FREQS){
    const od = state.OD[f];
    const oe = state.OE[f];
    if(Number.isFinite(od) && Number.isFinite(oe)){
      if(Math.abs(od-oe) >= 15) count++;
    }
  }
  return count >= 2 ? "Assimetria relevante (≥15 dB em ≥2 frequências)." : "";
}

function updateAutoInterpretation(){
  const ta = $("interpretacao");
  const current = (ta.value || "").trim();

  if(current.length > 90 && !current.startsWith("Resumo automático (editável):")){
    return;
  }

  const ptaOD = computePTA("OD");
  const ptaOE = computePTA("OE");
  const cOD = classifyPTA(ptaOD);
  const cOE = classifyPTA(ptaOE);
  const asy = asymmetryNote();

  const auto =
`Resumo automático (editável):
OD: PTA ${ptaOD ?? "—"} dB — ${cOD}.
OE: PTA ${ptaOE ?? "—"} dB — ${cOE}.
${asy ? `Observação: ${asy}` : ""}

Interpretação clínica:`;

  if(!current || current.length < 30 || current.startsWith("Resumo automático (editável):")){
    ta.value = auto.trim() + "\n";
  }

  state.interpretacao = ta.value;
  saveLocal();
}

/* ===== UI: tabela ===== */

function buildTable(){
  const tbody = $("tabela");
  tbody.innerHTML = "";

  for(const f of FREQS){
    const tr = document.createElement("tr");

    const tdHz = document.createElement("td");
    tdHz.textContent = f;
    tr.appendChild(tdHz);

    tr.appendChild(makeDbCell("OD", f));
    tr.appendChild(makeDbCell("OE", f));

    tbody.appendChild(tr);

    if(!(f in state.OD)) state.OD[f] = null;
    if(!(f in state.OE)) state.OE[f] = null;
  }
}

function makeDbCell(ear, freq){
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.type = "number";
  input.step = "5";
  input.min = DB_MIN;
  input.max = DB_MAX;
  input.placeholder = "dB";
  input.className = "db-input";
  input.dataset.ear = ear;
  input.dataset.freq = String(freq);

  const val = state[ear][freq];
  input.value = Number.isFinite(val) ? String(val) : "";

  input.addEventListener("input", (e)=>{
    const ear = e.target.dataset.ear;
    const freq = Number(e.target.dataset.freq);
    const v = parseDb(e.target.value);
    state[ear][freq] = v;

    saveLocal();
    updatePTAPills();
    drawAudiogram();
    updateAutoInterpretation();
  });

  td.appendChild(input);
  return td;
}

function updatePTAPills(){
  const ptaOD = computePTA("OD");
  const ptaOE = computePTA("OE");
  $("ptaOD").textContent = `PTA OD: ${ptaOD ?? "—"} (${ptaOD === null ? "—" : classifyPTA(ptaOD)})`;
  $("ptaOE").textContent = `PTA OE: ${ptaOE ?? "—"} (${ptaOE === null ? "—" : classifyPTA(ptaOE)})`;
}

/* ===== Canvas audiograma ===== */

function idxToX(i, plot){
  const t = i / (FREQS.length - 1);
  return plot.x + t * plot.w;
}

function dbToY(db, plot){
  const t = (db - DB_MIN) / (DB_MAX - DB_MIN);
  return plot.y + t * plot.h;
}

function freqLabel(f){
  if(f >= 1000) return `${f/1000}k`;
  return String(f);
}

function drawGrid(plot){
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // fundo
  ctx.fillStyle = "#08110d";
  ctx.fillRect(0,0,canvas.width,canvas.height);

  // área do plot
  ctx.fillStyle = "rgba(255,255,255,0.02)";
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

  // horizontais (0-120)
  ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  for(let db=0; db<=120; db+=10){
    const y = dbToY(db, plot);
    ctx.strokeStyle = (db % 20 === 0) ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.12)";
    ctx.lineWidth = (db % 20 === 0) ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();

    ctx.fillStyle = "rgba(233,255,245,0.80)";
    ctx.fillText(String(db), plot.x - 36, y + 5);
  }

  // verticais (freq)
  for(let i=0;i<FREQS.length;i++){
    const x = idxToX(i, plot);
    const f = FREQS[i];

    // linhas principais (1k,2k,4k,8k) um pouco mais fortes
    const major = (f === 1000 || f === 2000 || f === 4000 || f === 8000);
    ctx.strokeStyle = major ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.10)";
    ctx.lineWidth = major ? 1.4 : 1;

    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();

    // label
    const label = freqLabel(f);
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(233,255,245,0.85)";
    ctx.fillText(label, x - tw/2, plot.y + plot.h + 26);
  }

  // moldura
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1.2;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);

  // título
  ctx.fillStyle = "rgba(233,255,245,0.85)";
  ctx.fillText("dB HL", 14, 26);
}

function drawSeries(ear, plot){
  const color = (ear === "OD") ? "#ff5b5b" : "#4da3ff";
  const points = [];

  for(let i=0;i<FREQS.length;i++){
    const f = FREQS[i];
    const v = state[ear][f];
    if(Number.isFinite(v)){
      points.push({x: idxToX(i, plot), y: dbToY(v, plot)});
    }
  }
  if(points.length === 0) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  points.forEach((p, idx)=>{
    if(idx === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();

  // marcadores
  ctx.lineWidth = 3;
  points.forEach((p)=>{
    ctx.strokeStyle = color;
    if(ear === "OD"){
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI*2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(p.x-9, p.y-9);
      ctx.lineTo(p.x+9, p.y+9);
      ctx.moveTo(p.x+9, p.y-9);
      ctx.lineTo(p.x-9, p.y+9);
      ctx.stroke();
    }
  });
}

function drawAudiogram(){
  const pad = {l: 66, r: 18, t: 28, b: 42};
  const plot = {
    x: pad.l,
    y: pad.t,
    w: canvas.width - pad.l - pad.r,
    h: canvas.height - pad.t - pad.b
  };

  drawGrid(plot);
  drawSeries("OD", plot);
  drawSeries("OE", plot);

  // faixa inferior
  const ptaOD = computePTA("OD");
  const ptaOE = computePTA("OE");
  const line = `PTA OD: ${ptaOD ?? "—"} (${ptaOD===null?"—":classifyPTA(ptaOD)})  |  PTA OE: ${ptaOE ?? "—"} (${ptaOE===null?"—":classifyPTA(ptaOE)})`;

  ctx.fillStyle = "rgba(233,255,245,0.85)";
  ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(line, 14, canvas.height - 12);
}

/* ===== PDF: Laudo ===== */

function tableTextLine(freq, od, oe){
  const f = String(freq).padEnd(5, " ");
  const a = (Number.isFinite(od) ? String(Math.round(od)) : "—").padEnd(4," ");
  const b = (Number.isFinite(oe) ? String(Math.round(oe)) : "—").padEnd(4," ");
  return `${f} | OD ${a} | OE ${b}`;
}

async function gerarPDF(){
  const { jsPDF } = window.jspdf || {};
  if(!jsPDF){
    alert("jsPDF não carregou. Dica: hospede o jsPDF localmente no repo pra funcionar offline 100%.");
    return;
  }

  state.paciente = ($("paciente").value || "").trim();
  state.data = ($("data").value || "").trim();
  state.interpretacao = ($("interpretacao").value || "").trim();
  saveLocal();

  drawAudiogram();
  const img = canvas.toDataURL("image/png", 1.0);

  const doc = new jsPDF({ unit:"mm", format:"a4" });

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("BTX AudioLaudo — Laudo de Audiometria Tonal", 14, 16);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(`Paciente: ${state.paciente || "______________________________"}`, 14, 26);
  doc.text(`Data: ${state.data || "____/____/______"}`, 160, 26);

  const ptaOD = computePTA("OD");
  const ptaOE = computePTA("OE");
  doc.setFont("helvetica", "bold");
  doc.text("Resumo", 14, 36);
  doc.setFont("helvetica", "normal");
  doc.text(`PTA OD: ${ptaOD ?? "—"} dB — ${ptaOD===null?"—":classifyPTA(ptaOD)}`, 14, 43);
  doc.text(`PTA OE: ${ptaOE ?? "—"} dB — ${ptaOE===null?"—":classifyPTA(ptaOE)}`, 14, 50);

  doc.setFont("helvetica", "bold");
  doc.text("Audiograma", 14, 62);
  doc.addImage(img, "PNG", 14, 66, 182, 78);

  let y = 150;
  doc.setFont("helvetica", "bold");
  doc.text("Limiar por frequência (dB HL)", 14, y);
  y += 7;

  doc.setFont("courier", "normal");
  doc.setFontSize(10);
  doc.text("Hz    | OD   | OE", 14, y);
  y += 6;

  for(const f of FREQS){
    doc.text(tableTextLine(f, state.OD[f], state.OE[f]), 14, y);
    y += 6;
    if(y > 260){
      doc.addPage();
      y = 20;
    }
  }

  y += 4;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Interpretação", 14, y);
  y += 6;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const interp = state.interpretacao || "—";
  const lines = doc.splitTextToSize(interp, 182);
  doc.text(lines, 14, y);

  doc.setFontSize(9);
  doc.text("✨ Saudações aos nossos amigos fonoaudiólogos — tecnologia a favor da audição ✨", 14, 290);

  const safe = (state.paciente || "Paciente").replace(/[^\w\s-]/g,"").trim().replace(/\s+/g,"_");
  doc.save(`BTX_AudioLaudo_${safe}.pdf`);
}

/* ===== PDF: Agenda do dia ===== */

function formatDateBR(iso){
  if(!iso) return "";
  const [y,m,d] = iso.split("-");
  if(!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

async function gerarPDFagendaDoDia(){
  const { jsPDF } = window.jspdf || {};
  if(!jsPDF){
    alert("jsPDF não carregou. Dica: hospede o jsPDF localmente no repo pra funcionar offline 100%.");
    return;
  }

  const dateISO = ($("agData").value || "").trim() || todayISO();
  const list = agendaForDay(dateISO);

  const doc = new jsPDF({ unit:"mm", format:"a4" });
  doc.setFont("helvetica","bold");
  doc.setFontSize(16);
  doc.text("BTX AudioLaudo — Agenda do dia", 14, 16);

  doc.setFont("helvetica","normal");
  doc.setFontSize(11);
  doc.text(`Data: ${formatDateBR(dateISO)}`, 14, 26);
  doc.text(`Total: ${list.length}`, 160, 26);

  let y = 38;
  doc.setFont("helvetica","bold");
  doc.text("Horário", 14, y);
  doc.text("Paciente", 40, y);
  doc.text("Tipo", 140, y);
  y += 6;

  doc.setFont("helvetica","normal");
  doc.setFontSize(10);

  if(list.length === 0){
    doc.text("Sem agendamentos neste dia.", 14, y);
  } else {
    list.forEach(it=>{
      if(y > 280){
        doc.addPage();
        y = 20;
      }
      doc.text(String(it.hora || "--:--"), 14, y);
      doc.text(String(it.paciente || "—").slice(0, 40), 40, y);
      doc.text(String(it.tipo || "—").slice(0, 20), 140, y);
      y += 6;

      if(it.obs){
        doc.setFontSize(9);
        doc.text(`Obs: ${String(it.obs).slice(0, 100)}`, 40, y);
        doc.setFontSize(10);
        y += 6;
      }
    });
  }

  doc.setFontSize(9);
  doc.text("Gerado offline — BTX AudioLaudo", 14, 290);
  doc.save(`BTX_Agenda_${dateISO}.pdf`);
}

/* ===== Agenda UI ===== */

function renderAgenda(){
  const dateISO = ($("agData").value || "").trim() || todayISO();
  const list = agendaForDay(dateISO);
  const box = $("agLista");
  box.innerHTML = "";

  if(list.length === 0){
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "Sem agendamentos pra este dia.";
    box.appendChild(empty);
    return;
  }

  list.forEach(it=>{
    const div = document.createElement("div");
    div.className = "item";
    div.dataset.id = it.id;

    const left = document.createElement("div");
    left.className = "left";
    const strong = document.createElement("div");
    strong.style.fontWeight = "800";
    strong.textContent = `${it.hora || "--:--"} — ${it.paciente || "Sem nome"}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${it.tipo || "—"}${it.fone ? " • " + it.fone : ""}${it.obs ? " • " + it.obs : ""}`;

    left.appendChild(strong);
    left.appendChild(meta);

    const right = document.createElement("div");
    right.className = "right";

    const btnLoad = document.createElement("button");
    btnLoad.className = "smallbtn";
    btnLoad.textContent = "Usar no laudo";
    btnLoad.addEventListener("click", (e)=>{
      e.stopPropagation();
      loadFromAgenda(it);
    });

    const btnZap = document.createElement("button");
    btnZap.className = "smallbtn";
    btnZap.textContent = "WhatsApp";
    btnZap.addEventListener("click", (e)=>{
      e.stopPropagation();
      if(!it.fone){
        alert("Sem telefone no agendamento.");
        return;
      }
      const msg = encodeURIComponent(`Olá, ${it.paciente || ""}! Confirmando seu atendimento (${it.tipo || "consulta"}) em ${formatDateBR(it.data)} às ${it.hora || ""}.`);
      const url = `https://wa.me/${normalizePhone(it.fone)}?text=${msg}`;
      window.open(url, "_blank");
    });

    const btnDel = document.createElement("button");
    btnDel.className = "smallbtn danger";
    btnDel.textContent = "Excluir";
    btnDel.addEventListener("click", (e)=>{
      e.stopPropagation();
      if(confirm("Excluir este agendamento?")){
        agendaState.items = agendaState.items.filter(x => x.id !== it.id);
        saveAgenda();
        renderAgenda();
      }
    });

    right.appendChild(btnLoad);
    right.appendChild(btnZap);
    right.appendChild(btnDel);

    div.appendChild(left);
    div.appendChild(right);

    // clique no cartão também carrega no laudo
    div.addEventListener("click", ()=> loadFromAgenda(it));

    box.appendChild(div);
  });
}

function loadFromAgenda(it){
  // preenche no laudo
  state.paciente = String(it.paciente || "").trim();
  state.data = String(it.data || "").trim();

  $("paciente").value = state.paciente;
  $("data").value = state.data || todayISO();

  saveLocal();

  // troca pra aba audiograma
  document.querySelectorAll(".tab").forEach(b=>b.classList.remove("active"));
  document.querySelector('.tab[data-tab="tab-audio"]').classList.add("active");
  document.querySelectorAll(".panel").forEach(p=>p.classList.remove("active"));
  $("tab-audio").classList.add("active");

  // atualiza
  renderAll();
}

/* ===== Render geral ===== */

function renderAll(){
  $("paciente").value = state.paciente || "";
  $("data").value = state.data || todayISO();
  $("interpretacao").value = state.interpretacao || "";

  buildTable();
  updatePTAPills();
  drawAudiogram();
  updateAutoInterpretation();
}

/* ===== Wire ===== */

function wire(){
  // laudo
  $("paciente").addEventListener("input", ()=>{
    state.paciente = ($("paciente").value || "").trim();
    saveLocal();
  });

  $("data").addEventListener("change", ()=>{
    state.data = ($("data").value || "").trim();
    saveLocal();
  });

  $("interpretacao").addEventListener("input", ()=>{
    state.interpretacao = $("interpretacao").value || "";
    saveLocal();
  });

  $("btnPDF").addEventListener("click", gerarPDF);
  $("btnLimpar").addEventListener("click", ()=>{
    if(confirm("Limpar todos os dados desta tela?")){
      clearAll();
    }
  });

  // agenda
  $("btnAgAdd").addEventListener("click", ()=>{
    const data = ($("agData").value || "").trim() || todayISO();
    const hora = ($("agHora").value || "").trim();
    const paciente = ($("agPaciente").value || "").trim();
    const tipo = ($("agTipo").value || "").trim();
    const fone = normalizePhone($("agFone").value || "");
    const obs  = ($("agObs").value || "").trim();

    if(!hora || !paciente){
      alert("Preencha pelo menos Hora e Paciente.");
      return;
    }

    agendaState.items.push({ id: uuid(), data, hora, paciente, tipo, fone, obs });
    saveAgenda();

    // limpa campos rápidos
    $("agHora").value = "";
    $("agPaciente").value = "";
    $("agFone").value = "";
    $("agObs").value = "";

    renderAgenda();
  });

  $("btnAgPdf").addEventListener("click", gerarPDFagendaDoDia);

  $("btnAgClear").addEventListener("click", ()=>{
    if(confirm("Apagar TODA a agenda salva neste aparelho?")){
      agendaState.items = [];
      saveAgenda();
      renderAgenda();
    }
  });

  $("agData").addEventListener("change", renderAgenda);

  window.addEventListener("resize", ()=>{
    drawAudiogram();
  });
}

/* ===== Start ===== */

document.addEventListener("DOMContentLoaded", ()=>{
  wireTabs();

  canvas = $("grafico");
  ctx = canvas.getContext("2d");

  // init chaves
  for(const f of FREQS){ state.OD[f] = null; state.OE[f] = null; }
  state.data = todayISO();

  loadLocal();
  loadAgenda();

  // agenda data default
  $("agData").value = todayISO();

  wire();
  renderAll();
  renderAgenda();
});
