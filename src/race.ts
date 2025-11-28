import { formatBigNumber } from './utils.js';

// --- CONFIG ---
const GRAPH_API_KEY = 'bb77dd994c8e90edcbd73661a326f068';
const SUBGRAPH_ID = 'EGWFdhhiWypDuz22Uy7b3F69E9MEkyfU9iAQMttkH5Rj';
const GRAPH_URL = `https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/${SUBGRAPH_ID}`;

// START DATE: November 25, 2023
const START_DATE_ISO = '2023-11-25T00:00:00Z';
const START_DATE = Math.floor(new Date(START_DATE_ISO).getTime() / 1000);

const DISPLAY_COUNT = 50; 
const SNAPSHOT_INTERVAL_DAYS = 15; 
const ROW_HEIGHT = 18; 

const BAR_COLORS = [
  'bg-red-600',
  'bg-orange-500',
  'bg-yellow-400',
  'bg-lime-600',
  'bg-green-600',
  'bg-emerald-500',
  'bg-teal-600',
  'bg-cyan-500',
  'bg-sky-600',
  'bg-blue-600',
  'bg-indigo-600',
  'bg-purple-600',
  'bg-fuchsia-600',
  'bg-pink-500',
  'bg-rose-600',
  'bg-amber-500',
  'bg-slate-600',
  'bg-stone-600'
];

// --- UTILS ---
const formatCurrency = (weiValue) => {
    if (!weiValue) return '0';
    const val = parseFloat(weiValue) / 1e18;
    return val.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).replace(/,/g, ' ');
};

const parseMetadata = (metadataStr, id) => {
    const defaultName = `Operator ${id.slice(0, 6)}`;
    try {
        if (!metadataStr) return { name: defaultName };
        const json = JSON.parse(metadataStr);
        return { name: json.name || defaultName };
    } catch (e) {
        return { name: defaultName };
    }
};

const formatDate = (timestamp) => {
    return new Date(timestamp * 1000).toLocaleDateString('en-US', { 
        year: 'numeric', month: 'short', day: 'numeric' 
    }).replace(',', '');
};

const calculateNiceStep = (maxValData) => {
    if (maxValData === 0) return 1000;
    
    const roughStep = maxValData / 16;
    
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const normalizedStep = roughStep / magnitude;
    
    let niceStep;
    if (normalizedStep < 1.5) niceStep = 1;
    else if (normalizedStep < 3) niceStep = 2; // e.g. 20, 200, 2M
    else if (normalizedStep < 7) niceStep = 5; // e.g. 50, 500, 5M
    else niceStep = 10;
    
    return niceStep * magnitude;
};

export const RaceLogic = {
    state: {
        timelineData: [],
        operatorMetaMap: {},
        rawBuckets: [], 
        allOperatorIds: [], 
        filterDeprecated: false,
        currentIndex: 0,
        isPlaying: false,
        playbackSpeed: 100,
        activeMetric: 'stake', 
        timer: null,
        domElements: new Map(),
        hasInitialized: false
    },

    els: {},

    init: async function() {
        if (!this.state.hasInitialized) {
        
        this.els = {
            loadingState: document.getElementById('loading-state'),
            loadingBar: document.getElementById('loading-bar'),
            loadingText: document.getElementById('loading-text'),
            loadingMini: document.getElementById('loading-mini'),
            errorState: document.getElementById('error-state'),
            errorMsg: document.getElementById('error-msg'),
            chartArea: document.getElementById('chart-area'),
            barsContainer: document.getElementById('bars-container'),
            
            bgYearDisplay: document.getElementById('bg-year-display'),
            bgDayDisplay: document.getElementById('bg-day-display'),
            
            lblCurrentDate: document.getElementById('lbl-current-date'),
            slider: document.getElementById('timeline-slider'),
            btnPlay: document.getElementById('btn-play'),
            btnSpeed: document.getElementById('btn-speed'),
            btnMetricStake: document.getElementById('btn-metric-stake'),
            btnMetricEarnings: document.getElementById('btn-metric-earnings'),
            toggleFilter: document.getElementById('toggle-filter'),
            btnTryAgain: document.getElementById('btn-try-again')
        };

        // Attach event listeners
        if (this.els.btnPlay) this.els.btnPlay.addEventListener('click', () => this.togglePlay());
        if (this.els.btnSpeed) this.els.btnSpeed.addEventListener('click', () => this.toggleSpeed());
        if (this.els.toggleFilter) this.els.toggleFilter.addEventListener('change', () => this.toggleFilter());
        if (this.els.slider) {
            this.els.slider.addEventListener('input', (e) => {
                this.state.isPlaying = false;
                this.updatePlayButton();
                this.state.currentIndex = parseInt(e.target.value);
                this.renderFrame(this.state.currentIndex);
            });
        }
        if (this.els.btnMetricStake) this.els.btnMetricStake.addEventListener('click', () => this.setMetric('stake'));
        if (this.els.btnMetricEarnings) this.els.btnMetricEarnings.addEventListener('click', () => this.setMetric('earnings'));
        if (this.els.btnTryAgain) this.els.btnTryAgain.addEventListener('click', () => this.init());

        this.state.hasInitialized = true;
        }
        this.resetUI();
        try {
            await this.fetchData();
        } catch (err) {
            console.error(err);
            if (this.els.loadingState) this.els.loadingState.classList.add('hidden');
            if (this.els.errorMsg) this.els.errorMsg.textContent = err.message || "Error loading data";
            if (this.els.errorState) this.els.errorState.classList.remove('hidden');
        }
    },

    stop: function() {
        this.state.isPlaying = false;
        if (this.state.timer) {
            clearTimeout(this.state.timer);
            this.state.timer = null;
        }
        this.updatePlayButton();
    },

    resetUI: function() {
        if (this.els.errorState) this.els.errorState.classList.add('hidden');
        if (this.els.chartArea) this.els.chartArea.classList.add('hidden');
        if (this.els.loadingState) this.els.loadingState.classList.remove('hidden');
        if (this.els.loadingBar) this.els.loadingBar.style.width = '0%';
        if (this.els.loadingText) this.els.loadingText.textContent = "Discovering operators...";
        
        this.state.currentIndex = 0;
        this.state.isPlaying = false;
        this.state.timelineData = [];
        this.state.domElements.clear();
        if (this.els.barsContainer) {
            this.els.barsContainer.innerHTML = ''; 
            this.els.barsContainer.style.height = `${DISPLAY_COUNT * ROW_HEIGHT + 40}px`;
        }
        this.updatePlayButton();
    },

    setMetric: function(metric) {
        this.state.activeMetric = metric;
        
        const sliderThumb = this.els.slider;
        if(metric === 'stake') {
            this.els.btnMetricStake.classList.add('active');
            this.els.btnMetricStake.classList.remove('earnings-mode');
            this.els.btnMetricEarnings.classList.remove('active', 'earnings-mode');
            if (sliderThumb) sliderThumb.style.accentColor = '#2563eb'; 
        } else {
            this.els.btnMetricStake.classList.remove('active');
            this.els.btnMetricEarnings.classList.add('active', 'earnings-mode');
            if (sliderThumb) sliderThumb.style.accentColor = '#059669'; 
        }

        this.renderFrame(this.state.currentIndex);
    },

    discoverTopOperators: async function() {
        const uniqueOperatorIds = new Set();
        const now = Math.floor(Date.now() / 1000);
        const interval = SNAPSHOT_INTERVAL_DAYS * 24 * 60 * 60;
        let checkpoints = [];

        for (let t = START_DATE; t <= now; t += interval) {
            checkpoints.push(t);
        }
        checkpoints.push(now); 

        let queryBody = '';
        checkpoints.forEach((ts, idx) => {
            queryBody += `
                t${idx}: operatorDailyBuckets(
                    first: 75
                    orderBy: valueWithoutEarnings
                    orderDirection: desc
                    where: { date_gte: "${ts}", date_lt: "${ts + 86400}" }
                ) {
                    operator { id }
                }
            `;
        });

        queryBody += `
            currentTop: operators(
                first: 75
                orderBy: valueWithoutEarnings
                orderDirection: desc
            ) {
                id
            }
        `;

        const batchQuery = `query { ${queryBody} }`;

        if (this.els.loadingText) this.els.loadingText.textContent = `Scanning history (${checkpoints.length} snapshots)...`;
        if (this.els.loadingBar) this.els.loadingBar.style.width = '30%';

        const res = await fetch(GRAPH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: batchQuery })
        });

        const json = await res.json();
        if (json.errors) throw new Error(json.errors[0].message);

        Object.values(json.data).forEach(group => {
            group.forEach(item => {
                const id = item.operator ? item.operator.id : item.id;
                uniqueOperatorIds.add(id);
            });
        });

        console.log(`Found ${uniqueOperatorIds.size} distinct operators.`);
        return Array.from(uniqueOperatorIds);
    },

    fetchData: async function() {
        const operatorIds = await this.discoverTopOperators();
        this.state.allOperatorIds = operatorIds;
        
        if (this.els.loadingText) this.els.loadingText.textContent = "Fetching details...";
        if (this.els.loadingBar) this.els.loadingBar.style.width = '50%';

        const chunkSize = 100;
        for (let i = 0; i < operatorIds.length; i += chunkSize) {
            const chunk = operatorIds.slice(i, i + chunkSize);
            const metaQuery = `
                query {
                    operators(where: { id_in: ${JSON.stringify(chunk)} }, first: 1000) {
                        id
                        metadataJsonString
                    }
                }
            `;
            const metaRes = await fetch(GRAPH_URL, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ query: metaQuery })
            });
            const metaJson = await metaRes.json();
            if (metaJson.data && metaJson.data.operators) {
                metaJson.data.operators.forEach(op => {
                    const meta = parseMetadata(op.metadataJsonString, op.id);
                    this.state.operatorMetaMap[op.id] = {
                        name: meta.name,
                        color: BAR_COLORS[parseInt(op.id.slice(-2), 16) % BAR_COLORS.length]
                    };
                });
            }
        }

        if (this.els.loadingText) this.els.loadingText.textContent = "Reconstructing timeline...";
        let allBuckets = [];
        let lastDate = START_DATE;
        let fetching = true;
        let progress = 50;

        while(fetching) {
            progress = Math.min(progress + 5, 95);
            if (this.els.loadingBar) this.els.loadingBar.style.width = `${progress}%`;

            const histQuery = `
                query GetHistory($ids: [ID!], $since: BigInt!) {
                    operatorDailyBuckets(
                        where: { operator_in: $ids, date_gt: $since }
                        first: 1000
                        orderBy: date
                        orderDirection: asc
                    ) {
                        date
                        valueWithoutEarnings
                        cumulativeEarningsWei
                        operator { id }
                    }
                }
            `;

            const res = await fetch(GRAPH_URL, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    query: histQuery,
                    variables: { ids: operatorIds, since: lastDate.toString() }
                })
            });
            const json = await res.json();
            if(json.errors) throw new Error("History error");
            
            const buckets = json.data.operatorDailyBuckets;
            if(buckets.length === 0) {
                fetching = false;
            } else {
                allBuckets = [...allBuckets, ...buckets];
                lastDate = buckets[buckets.length - 1].date;
                if(buckets.length < 1000) fetching = false;
            }
        }

        this.state.rawBuckets = allBuckets;
        if (this.els.loadingBar) this.els.loadingBar.style.width = '100%';

        this.processTimeline(allBuckets, operatorIds);
        
        if (this.state.timelineData.length > 0) {
            this.state.currentIndex = this.state.timelineData.length - 1;
        }

        if (this.els.loadingState) this.els.loadingState.classList.add('hidden');
        if (this.els.chartArea) this.els.chartArea.classList.remove('hidden');
        
        this.renderFrame(this.state.currentIndex);
    },

    processTimeline: function(buckets, operatorIds) {
        const bucketsByDate = {};
        const uniqueDates = new Set();
        const blacklist = ['old', 'testnet', 'deprecated']; 

        buckets.forEach(b => {
            const d = parseInt(b.date);
            uniqueDates.add(d);
            if(!bucketsByDate[d]) bucketsByDate[d] = {};
            bucketsByDate[d][b.operator.id] = {
                stake: b.valueWithoutEarnings,
                earnings: b.cumulativeEarningsWei
            };
        });

        const sortedDates = Array.from(uniqueDates).sort((a,b) => a - b);
        
        if(sortedDates.length === 0) throw new Error("No data found");

        let lastKnownValues = {};
        operatorIds.forEach(id => lastKnownValues[id] = { stake: '0', earnings: '0' });

        this.state.timelineData = sortedDates.map(date => {
            const daysData = bucketsByDate[date];
            if(daysData) {
                Object.keys(daysData).forEach(opId => {
                    if(daysData[opId].stake) lastKnownValues[opId].stake = daysData[opId].stake;
                    if(daysData[opId].earnings) lastKnownValues[opId].earnings = daysData[opId].earnings;
                });
            }

            const validOperatorIds = operatorIds.filter(id => {
                if (!this.state.operatorMetaMap[id]) return false;
                if (this.state.filterDeprecated) {
                    const name = this.state.operatorMetaMap[id].name.toLowerCase();
                    return !blacklist.some(word => name.includes(word));
                }
                return true;
            });

            const rankingsStake = validOperatorIds
            .map(id => ({
                id: id,
                valueWei: lastKnownValues[id].stake,
                floatValue: parseFloat(lastKnownValues[id].stake),
                ...this.state.operatorMetaMap[id]
            }))
            .sort((a,b) => b.floatValue - a.floatValue)
            .slice(0, DISPLAY_COUNT); 

            const rankingsEarnings = validOperatorIds
            .map(id => ({
                id: id,
                valueWei: lastKnownValues[id].earnings,
                floatValue: parseFloat(lastKnownValues[id].earnings),
                ...this.state.operatorMetaMap[id]
            }))
            .sort((a,b) => b.floatValue - a.floatValue)
            .slice(0, DISPLAY_COUNT); 

            return {
                date: date,
                formattedDate: formatDate(date),
                stake: rankingsStake,
                earnings: rankingsEarnings
            };
        });

        if (this.els.slider) this.els.slider.max = Math.max(0, this.state.timelineData.length - 1);
        if(this.state.timelineData.length > 0 && this.els.lblCurrentDate) {
            this.els.lblCurrentDate.textContent = this.state.timelineData[0].formattedDate;
        }
    },

    renderFrame: function(index) {
        const frame = this.state.timelineData[index];
        if(!frame) return;

        if (this.els.lblCurrentDate) this.els.lblCurrentDate.textContent = frame.formattedDate;
        if (this.els.slider) this.els.slider.value = index;

        const dateObj = new Date(frame.date * 1000);
        const year = dateObj.getFullYear();
        const dayMonth = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        
        if (this.els.bgYearDisplay) this.els.bgYearDisplay.textContent = year;
        if (this.els.bgDayDisplay) this.els.bgDayDisplay.textContent = dayMonth;

        const currentRankings = this.state.activeMetric === 'stake' ? frame.stake : frame.earnings;
        const maxValWei = currentRankings.length > 0 ? currentRankings[0].floatValue : 1;
        const maxValData = maxValWei / 1e18;

        // --- NICE SCALE ALGORITHM ---
        const scaleStepData = calculateNiceStep(maxValData);

        const activeIds = new Set(currentRankings.map(r => r.id));

        currentRankings.forEach((item, rank) => {
            let el = this.state.domElements.get(item.id);

            if(!el) {
                el = document.createElement('div');
                el.className = 'bar-row';
                el.style.top = '700px'; 
                el.innerHTML = `
                    <div class="w-6 text-[12px] text-gray-500 font-bold text-right shrink-0 rank-num"></div>
                    <div class="w-48 flex items-center justify-end shrink-0">
                        <span class="text-[12px] font-medium text-gray-300 truncate max-w-full text-right operator-name"></span>
                    </div>
                    <div class="flex-1 flex items-center gap-2 h-full bar-track">
                        <div class="bar-fill shadow-sm bg-opacity-90 relative"></div>
                        <span class="text-[9px] font-bold text-gray-400 tabular-nums value-text whitespace-nowrap"></span>
                    </div>
                `;
                el.querySelector('.operator-name').textContent = item.name;
                el.querySelector('.operator-name').title = item.name;
                el.querySelector('.bar-fill').classList.add(...item.color.split(' ')); 
                this.els.barsContainer.appendChild(el);
                this.state.domElements.set(item.id, el);
            }

            el.classList.remove('bar-hidden'); 
            el.style.top = `${rank * ROW_HEIGHT}px`;
            el.querySelector('.rank-num').textContent = rank + 1;
            
            const valData = item.floatValue / 1e18;
            const widthPercent = Math.max((item.floatValue / maxValWei) * 100, 0.5);
            
            const barFill = el.querySelector('.bar-fill');
            barFill.style.width = `${widthPercent}%`;
            el.querySelector('.value-text').textContent = formatCurrency(item.valueWei);

            // MARKERS
            const existingMarkers = barFill.querySelectorAll('.scale-marker-line');
            existingMarkers.forEach(m => m.remove());
            
            if (valData > 0) {
                const numberOfMarkers = Math.floor(valData / scaleStepData);
                const safeLimit = Math.min(numberOfMarkers, 100); 

                for (let i = 1; i <= safeLimit; i++) {
                    const markerValueData = i * scaleStepData;
                    const posPercent = (markerValueData / valData) * 100;
                    if (posPercent < 99) { 
                        const line = document.createElement('div');
                        line.className = 'scale-marker-line';
                        line.style.left = `${posPercent}%`;
                        barFill.appendChild(line);
                    }
                }
            }
        });

        this.state.domElements.forEach((el, id) => {
            if (!activeIds.has(id)) {
                el.classList.add('bar-hidden');
                el.style.top = '700px'; 
            }
        });
    },

    togglePlay: function() {
        this.state.isPlaying = !this.state.isPlaying;
        this.updatePlayButton();
        if (this.state.isPlaying) {
            if (this.state.currentIndex >= this.state.timelineData.length - 1) {
                this.state.currentIndex = 0;
            }
            this.loop();
        } else {
            clearTimeout(this.state.timer);
        }
    },

    loop: function() {
        if (!this.state.isPlaying) return;
        this.renderFrame(this.state.currentIndex);
        if (this.state.currentIndex >= this.state.timelineData.length - 1) {
            this.state.isPlaying = false;
            this.updatePlayButton();
            return;
        }
        this.state.currentIndex++;
        this.state.timer = setTimeout(() => this.loop(), this.state.playbackSpeed);
    },

    updatePlayButton: function() {
        if (!this.els.btnPlay) return;
        
        if (this.state.isPlaying) {
            this.els.btnPlay.innerHTML = '<i data-lucide="pause" class="w-3 h-3 fill-current"></i>';
            this.els.btnPlay.classList.add('pulse-active');
        } else {
            this.els.btnPlay.innerHTML = '<i data-lucide="play" class="w-3 h-3 ml-0.5 fill-current"></i>';
            this.els.btnPlay.classList.remove('pulse-active');
        }

        if (window.lucide) window.lucide.createIcons();
    },

    toggleSpeed: function() {
        this.state.playbackSpeed = this.state.playbackSpeed === 100 ? 30 : 100;
        const btn = this.els.btnSpeed;
        if (!btn) return;
        
        if (this.state.playbackSpeed === 30) {
            btn.classList.add('text-blue-400');
            btn.classList.remove('text-gray-400');
        } else {
            btn.classList.remove('text-blue-400');
            btn.classList.add('text-gray-400');
        }
    },

    toggleFilter: function() {
        this.state.filterDeprecated = !this.state.filterDeprecated;
        if (this.els.loadingMini) this.els.loadingMini.classList.remove('hidden');
        setTimeout(() => {
            if (this.state.rawBuckets.length > 0) {
                this.processTimeline(this.state.rawBuckets, this.state.allOperatorIds);
                this.renderFrame(this.state.currentIndex);
            }
            if (this.els.loadingMini) this.els.loadingMini.classList.add('hidden');
        }, 50);
    }
};
