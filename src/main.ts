import * as Constants from './constants.js';
import * as Utils from './utils.js';
import * as UI from './ui.js';
import * as Services from './services.js';
import { RaceLogic } from './race.js';
import { VisualLogic } from './visual.js';

// --- Global State ---
let state = {
    signer: null,
    myRealAddress: '',
    currentOperatorId: null,
    currentOperatorData: null,
    currentDelegations: [],
    sponsorshipHistory: [],
    operatorDailyBuckets: [],
    historicalDataPriceMap: null, 
    chartTimeFrame: 90,
    totalDelegatorCount: 0,
    dataPriceUSD: null,
    loadedOperatorCount: 0,
    searchQuery: '',
    searchTimeout: null,
    detailsRefreshInterval: null,
    activeSponsorshipMenu: null,
    uiState: {
        isStatsPanelExpanded: false,
        isDelegatorViewActive: true,
        reputationViewIndex: 0,
        walletViewIndex: 0,
        isSponsorshipsListViewActive: true,
        isChartUsdView: false, // false = DATA, true = USD
    },
    activeNodes: new Set(),
    unreachableNodes: new Set(),
};

// --- Initialization ---

async function initializeApp() {
    await Services.cleanupClient();
    try {
        const streamrClient = new StreamrClient();
        Services.setStreamrClient(streamrClient);
        console.log("Streamr client initialized.");

        // Load CSV price data on startup
        state.historicalDataPriceMap = await Services.fetchHistoricalDataPrice();

        await Services.setupDataPriceStream((price) => {
            state.dataPriceUSD = price;
        });
        
        await fetchAndRenderOperatorsList();

        UI.loginModal.classList.add('hidden');
        UI.mainContainer.classList.remove('hidden');

    } catch (error) {
        console.error("Initialization failed:", error);
        UI.showCustomAlert('Initialization Error', `Failed to initialize the application: ${error.message}`);
        UI.setLoginModalState('buttons');
    }
}

function setupWalletListeners() {
    if (window.ethereum) {
        window.ethereum.on('accountsChanged', () => {
            console.log('Wallet account changed, reloading page.');
            window.location.reload();
        });
        window.ethereum.on('chainChanged', () => {
            console.log('Wallet network changed, reloading page.');
            window.location.reload();
        });
    }
}

async function connectWithWallet() {
    const injectedProvider = window.ethereum || window.top?.ethereum;
    if (!injectedProvider) {
        UI.showCustomAlert("MetaMask Not Found", "Please install the MetaMask extension.");
        return;
    }

    try {
        UI.setLoginModalState('loading', 'wallet');
        const provider = new ethers.providers.Web3Provider(injectedProvider);
        await provider.send("eth_requestAccounts", []);
        state.signer = provider.getSigner();
        state.myRealAddress = await state.signer.getAddress();

        if (!await Services.checkAndSwitchNetwork()) {
            UI.setLoginModalState('buttons');
            return;
        }

        UI.updateWalletUI(state.myRealAddress);
        setupWalletListeners();
        await initializeApp();
        sessionStorage.setItem('authMethod', 'metamask');

    } catch (err) {
        console.error("Wallet connection error:", err);
        state.myRealAddress = '';
        state.signer = null;
        UI.walletInfoEl.classList.add('hidden');
        const message = (err.code === 4001 || err.info?.error?.code === 4001) 
            ? "The signature request was rejected in your wallet."
            : "Wallet connection request was rejected or failed.";
        UI.showCustomAlert('Wallet Connection Failed', message);
        UI.setLoginModalState('buttons');
    }
}

async function connectAsGuest() {
    UI.setLoginModalState('loading', 'guest');
    state.myRealAddress = '';
    state.signer = null;
    UI.updateWalletUI(null); 
    sessionStorage.removeItem('authMethod');
    await initializeApp();
}

// --- Data Fetching and Rendering Orchestration ---

async function fetchAndRenderOperatorsList(isLoadMore = false, skip = 0, filterQuery = '') {
    UI.showLoader(!isLoadMore);
    try {
        const operators = await Services.fetchOperators(skip, filterQuery);

        if (isLoadMore) {
            UI.appendOperatorsList(operators);
        } else {
            UI.renderOperatorsList(operators, filterQuery);
        }

        if (!filterQuery || (filterQuery.toLowerCase().startsWith('0x'))) {
            state.loadedOperatorCount += operators.length;
        }
        
        UI.loadMoreOperatorsBtn.style.display = (operators.length === Constants.OPERATORS_PER_PAGE && (!filterQuery || filterQuery.toLowerCase().startsWith('0x'))) ? 'inline-block' : 'none';

    } catch (error) {
        console.error("Failed to fetch operators:", error);
        UI.operatorsGrid.innerHTML = `<p class="text-red-400 col-span-full">${Utils.escapeHtml(error.message)}</p>`;
    } finally {
        UI.showLoader(false);
    }
}

async function fetchAndRenderOperatorDetails(operatorId) {
    UI.showLoader(true);
    if (state.detailsRefreshInterval) clearInterval(state.detailsRefreshInterval);

    state.currentOperatorId = operatorId.toLowerCase();
    state.activeNodes.clear();
    state.unreachableNodes.clear();
    state.chartTimeFrame = 90;
    state.uiState.isChartUsdView = false; // Reset to DATA view

    try {
        await refreshOperatorData(true); // isFirstLoad = true
        state.detailsRefreshInterval = setInterval(() => refreshOperatorData(false), 30000);
    } catch (error) {
        UI.detailContent.innerHTML = `<p class="text-red-400">${Utils.escapeHtml(error.message)}</p>`;
    } finally {
        UI.showLoader(false);
    }
}

async function refreshOperatorData(isFirstLoad = false) {
    try {
        const data = await Services.fetchOperatorDetails(state.currentOperatorId);
        
        state.currentOperatorData = data.operator;
        state.currentDelegations = data.operator?.delegations || [];
        state.totalDelegatorCount = data.operator?.delegatorCount || 0;
        state.operatorDailyBuckets = data.operatorDailyBuckets || [];
        
        if (isFirstLoad) {
            let polygonscanTxs = [];
            try {
                polygonscanTxs = await Services.fetchPolygonscanHistory(state.currentOperatorId);
            } catch (error) {
                console.error("Failed to load Polygonscan history:", error);
            }
            
            processSponsorshipHistory(data, polygonscanTxs);
            
            UI.renderOperatorDetails(data, state);
            const addresses = [...(data.operator.controllers || []), ...(data.operator.nodes || [])];
            UI.renderBalances(addresses);
            updateMyStakeUI();
            setupOperatorStream();
            filterAndRenderChart();
            UI.renderSponsorshipsHistory(state.sponsorshipHistory);
        } else {
            UI.updateOperatorDetails(data, state);
            const addresses = [...(data.operator.controllers || []), ...(data.operator.nodes || [])];
            UI.renderBalances(addresses);
            updateMyStakeUI();
            filterAndRenderChart();
        }

    } catch (error) {
        console.error("Failed to refresh operator data:", error);
        if (isFirstLoad) {
            UI.detailContent.innerHTML = `<p class="text-red-400">${Utils.escapeHtml(error.message)}</p>`;
        }
    }
}

function processSponsorshipHistory(gqlData, polygonscanTxs) {
    const combinedEvents = new Map();

    (gqlData.stakingEvents || []).forEach(e => {
        const timestamp = Number(e.date); 
        if (!combinedEvents.has(timestamp)) {
            combinedEvents.set(timestamp, { timestamp, events: [] });
        }
        combinedEvents.get(timestamp).events.push({
            timestamp: timestamp,
            type: 'graph',
            amount: parseFloat(Utils.convertWeiToData(e.amount)),
            token: 'DATA',
            methodId: 'Staking Event',
            txHash: null,
            relatedObject: e.sponsorship
        });
    });

    (polygonscanTxs || []).forEach(tx => {
        const timestamp = Number(tx.timestamp); 
        if (!combinedEvents.has(timestamp)) {
            combinedEvents.set(timestamp, { timestamp, events: [] });
        }
        combinedEvents.get(timestamp).events.push({
            timestamp: timestamp,
            type: 'scan',
            amount: tx.amount,
            token: tx.token,
            methodId: tx.methodId,
            txHash: tx.txHash,
            relatedObject: tx.direction
        });
    });

    const unifiedHistory = Array.from(combinedEvents.values());
    unifiedHistory.sort((a, b) => b.timestamp - a.timestamp); 
    
    state.sponsorshipHistory = unifiedHistory;
}

function filterAndRenderChart() {
    const now = new Date();
    let latestKnownPrice = state.dataPriceUSD || 0;

    const chartData = state.operatorDailyBuckets.map(bucket => {
        const bucketDate = bucket.date; 
        
        // Filter by time window
        if (state.chartTimeFrame !== 'all') {
            const bucketDateObj = new Date(bucketDate * 1000);
            const daysAgo = (now - bucketDateObj) / (1000 * 60 * 60 * 24);
            if (daysAgo > state.chartTimeFrame) {
                return null; // Will be filtered out
            }
        }
        
        const dataAmount = parseFloat(Utils.convertWeiToData(bucket.valueWithoutEarnings));

        let value;
        if (state.uiState.isChartUsdView) {
            let price = state.historicalDataPriceMap.get(bucketDate);
            
            if (!price) {
                for (let i = 1; i <= 7; i++) { // Check up to 7 days prior
                    const priorDate = bucketDate - (i * 86400); 
                    price = state.historicalDataPriceMap.get(priorDate);
                    if (price) break;
                }
            }

            // Use the found historical price, or fallback to the *latest known live price*
            const priceToUse = price || latestKnownPrice;
            if (priceToUse > 0) latestKnownPrice = priceToUse; // Update latest known price
            
            value = dataAmount * priceToUse;
        } else {
            value = dataAmount;
        }
		
        const date = new Date(bucketDate * 1000);
        const month = date.toLocaleDateString(undefined, { month: 'short' });
        const day = date.getDate(); // Usar getDate() para obter "7" em vez de "07"
        const year = date.getFullYear().toString().substring(2); // 2025 -> "25"

        return {
            label: `${month} ${day} '${year}`, // Formato: "Nov 7 '25"
            value: value
        };

    }).filter(Boolean); // Remove null entries filtered by time window

    UI.renderStakeChart(chartData, state.uiState.isChartUsdView);
    UI.updateChartTimeframeButtons(state.chartTimeFrame, state.uiState.isChartUsdView);
}

async function updateMyStakeUI() {
    if (!state.myRealAddress) return;
    const myStakeSection = document.getElementById('my-stake-section');
    const myStakeValueEl = document.getElementById('my-stake-value');
    if (!myStakeSection || !myStakeValueEl) return;
    
    myStakeSection.classList.remove('hidden');
    myStakeValueEl.textContent = 'Loading...';

    const myStakeWei = await Services.fetchMyStake(state.currentOperatorId, state.myRealAddress, state.signer);
    const myStakeData = Utils.convertWeiToData(myStakeWei);
    myStakeValueEl.textContent = `${Utils.formatBigNumber(myStakeData)} DATA`;
    myStakeValueEl.setAttribute('data-tooltip-value', myStakeData);
}


// --- Event Handlers ---

function handleShowOperatorDetails(operatorId) {
    UI.displayView('detail');
    state.uiState.reputationViewIndex = 0;
    state.uiState.walletViewIndex = 0;
    state.uiState.isSponsorshipsListViewActive = true;
    fetchAndRenderOperatorDetails(operatorId);
}

function handleShowRace() {
    UI.displayView('race');
    RaceLogic.init();
}

function handleBackToFromRace() {
    RaceLogic.stop(); 
    UI.displayView('list');
}

function handleShowVisual() {
    UI.displayView('visual');
    // Inject the shared client instance
    VisualLogic.setClient(Services.getStreamrClient());
    VisualLogic.init();
}

function handleBackFromVisual() {
    VisualLogic.stop();
    UI.displayView('list');
}

async function handleLoadMoreOperators(button) {
    button.disabled = true;
    button.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Loading...`;
    try {
        await fetchAndRenderOperatorsList(true, state.loadedOperatorCount, state.searchQuery);
    } catch (error) {
        console.error("Failed to load more operators:", error);
    } finally {
        button.disabled = false;
        button.innerHTML = 'Load More Operators';
    }
}

function handleSearch(query) {
    if (state.searchTimeout) clearTimeout(state.searchTimeout);
    state.searchTimeout = setTimeout(() => {
        const trimmedQuery = query.trim();
        if (state.searchQuery !== trimmedQuery) {
            state.searchQuery = trimmedQuery;
            state.loadedOperatorCount = 0;
            fetchAndRenderOperatorsList(false, 0, state.searchQuery);
        }
    }, 300);
}

async function handleLoadMoreDelegators(button) {
    button.disabled = true;
    button.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Loading...`;
    try {
        const newDelegations = await Services.fetchMoreDelegators(state.currentOperatorId, state.currentDelegations.length);
        state.currentDelegations.push(...newDelegations);
        UI.updateDelegatorsSection(state.currentDelegations, state.totalDelegatorCount);
    } catch (error) {
        console.error("Failed to load more delegators:", error);
    } finally {
        button.disabled = false;
        button.textContent = 'Load More';
    }
}

// --- Transaction Handlers ---

async function handleDelegateClick() {
    if (!state.signer) {
        UI.showCustomAlert('Action Required', 'Please connect a wallet to delegate.');
        return;
    }
    if (!await Services.checkAndSwitchNetwork()) return;

    let maxAmountWei = await Services.manageTransactionModal(true, 'delegate', state.signer, state.myRealAddress, state.currentOperatorId);

    const confirmBtn = document.getElementById('tx-modal-confirm');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

    document.getElementById('tx-modal-max-btn').onclick = () => {
        if (maxAmountWei !== '0') {
            UI.txModalAmount.value = ethers.utils.formatEther(maxAmountWei);
        }
    };
    
    newConfirmBtn.addEventListener('click', async () => {
        newConfirmBtn.disabled = true;
        newConfirmBtn.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Processing...`;
        
        const txHash = await Services.confirmDelegation(state.signer, state.myRealAddress, state.currentOperatorId);
        if (txHash) {
            await refreshOperatorData(true);
        }

        newConfirmBtn.disabled = false;
        newConfirmBtn.textContent = 'Confirm';
    });
}

async function handleUndelegateClick() {
    if (!state.signer) {
        UI.showCustomAlert('Action Required', 'Please connect a wallet to undelegate.');
        return;
    }
    if (!await Services.checkAndSwitchNetwork()) return;

    let maxAmountWei = await Services.manageTransactionModal(true, 'undelegate', state.signer, state.myRealAddress, state.currentOperatorId);
    
    const confirmBtn = document.getElementById('tx-modal-confirm');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    
    document.getElementById('tx-modal-max-btn').onclick = () => {
        if (maxAmountWei !== '0') {
            UI.txModalAmount.value = ethers.utils.formatEther(maxAmountWei);
        }
    };
    
    newConfirmBtn.addEventListener('click', async () => {
        newConfirmBtn.disabled = true;
        newConfirmBtn.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Processing...`;

        const txHash = await Services.confirmUndelegation(state.signer, state.myRealAddress, state.currentOperatorId, state.currentOperatorData);
        if (txHash) {
           await refreshOperatorData(true);;
        }

        newConfirmBtn.disabled = false;
        newConfirmBtn.textContent = 'Confirm';
    });
}

async function handleProcessQueueClick(button) {
    if (!state.signer) {
        UI.showCustomAlert('Action Required', 'Please connect your wallet.');
        return;
    }
    button.disabled = true;
    button.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Processing...`;
    
    await Services.handleProcessQueue(state.signer, state.currentOperatorId);
    await refreshOperatorData(true);

    button.disabled = false;
    button.innerHTML = 'Process Queue';
}

async function handleEditStakeClick(sponsorshipId, currentStakeWei) {
    if (!state.signer) {
        UI.showCustomAlert('Action Required', 'Please connect your wallet.');
        return;
    }
    UI.setModalState('stake-modal', 'input');
    UI.stakeModal.classList.remove('hidden');

    const currentStakeData = Utils.convertWeiToData(currentStakeWei);
    UI.stakeModalCurrentStake.textContent = `${Utils.formatBigNumber(currentStakeData)} DATA`;
    UI.stakeModalAmount.value = parseFloat(currentStakeData);
    
    try {
        const tokenContract = new ethers.Contract(Constants.DATA_TOKEN_ADDRESS_POLYGON, Constants.DATA_TOKEN_ABI, state.signer.provider);
        const freeFundsWei = await tokenContract.balanceOf(state.currentOperatorId);
        UI.stakeModalFreeFunds.textContent = `${Utils.formatBigNumber(Utils.convertWeiToData(freeFundsWei))} DATA`;
        const maxStakeAmountWei = ethers.BigNumber.from(currentStakeWei).add(freeFundsWei).toString();
        
        document.getElementById('stake-modal-max-btn').onclick = () => {
            UI.stakeModalAmount.value = ethers.utils.formatEther(maxStakeAmountWei);
        };
    } catch(e) {
        console.error("Failed to get free funds:", e);
        UI.stakeModalFreeFunds.textContent = 'Error';
    }
    
    const confirmBtn = document.getElementById('stake-modal-confirm');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

    newConfirmBtn.addEventListener('click', async () => {
        newConfirmBtn.disabled = true;
        newConfirmBtn.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Processing...`;

        const result = await Services.confirmStakeEdit(state.signer, state.currentOperatorId, sponsorshipId, currentStakeWei);
        if (result && result !== 'nochange') {
            await refreshOperatorData(true);
        }
        
        newConfirmBtn.disabled = false;
        newConfirmBtn.textContent = 'Confirm';
    });
}

async function handleCollectEarningsClick(button, sponsorshipId) {
     if (!state.signer) {
        UI.showCustomAlert('Action Required', 'Please connect your wallet.');
        return;
    }
    button.classList.add('processing');
    const originalText = button.textContent;
    button.textContent = 'Processing...';

    await Services.handleCollectEarnings(state.signer, state.currentOperatorId, sponsorshipId);
    await refreshOperatorData(true);

    button.classList.remove('processing');
    button.textContent = originalText;
}

async function handleCollectAllEarningsClick(button) {
    if (!state.signer) {
        UI.showCustomAlert('Action Required', 'Please connect your wallet.');
        return;
    }
    button.disabled = true;
    button.innerHTML = `<div class_ = "w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div>`;

    await Services.handleCollectAllEarnings(state.signer, state.currentOperatorId, state.currentOperatorData);
    await refreshOperatorData(true);

    button.disabled = false;
    button.textContent = 'Collect All';
}

async function handleEditOperatorSettingsClick() {
    if (!state.signer) {
        UI.showCustomAlert('Action Required', 'Please connect your wallet.');
        return;
    }
    if (!await Services.checkAndSwitchNetwork()) return;

    UI.populateOperatorSettingsModal(state.currentOperatorData);
    UI.setModalState('operator-settings-modal', 'input');

    const originalConfirmBtn = document.getElementById('operator-settings-modal-confirm');
    const confirmBtn = originalConfirmBtn.cloneNode(true);
    originalConfirmBtn.parentNode.replaceChild(confirmBtn, originalConfirmBtn);

    const enableConfirm = () => { confirmBtn.disabled = false; };
    UI.operatorSettingsModalNameInput.addEventListener('input', enableConfirm, { once: true });
    UI.operatorSettingsModalDescriptionInput.addEventListener('input', enableConfirm, { once: true });
    UI.operatorSettingsModalCutInput.addEventListener('input', enableConfirm, { once: true });
    UI.operatorSettingsModalRedundancyInput.addEventListener('input', enableConfirm, { once: true });

    confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = `<div class="w-4 h-4 border-2 border-white rounded-full border-t-transparent btn-spinner"></div> Processing...`;
        UI.setModalState('operator-settings-modal', 'loading', { text: "Checking for changes...", subtext: "Please wait." });

        const oldMetadata = Utils.parseOperatorMetadata(state.currentOperatorData.metadataJsonString);
        let oldRedundancy = '1';
        try {
            if (state.currentOperatorData.metadataJsonString) {
                 const meta = JSON.parse(state.currentOperatorData.metadataJsonString);
                 if (meta && meta.redundancyFactor !== undefined) oldRedundancy = String(meta.redundancyFactor);
            }
        } catch(e) {}
        const oldCut = (BigInt(state.currentOperatorData.operatorsCutFraction) * 100n) / BigInt('1000000000000000000');

        const newName = UI.operatorSettingsModalNameInput.value;
        const newDescription = UI.operatorSettingsModalDescriptionInput.value;
        const newRedundancy = UI.operatorSettingsModalRedundancyInput.value;
        const newCut = UI.operatorSettingsModalCutInput.value;

        const metadataChanged = newName !== (oldMetadata.name || '') ||
                                newDescription !== (oldMetadata.description || '') ||
                                newRedundancy !== oldRedundancy;
        
        const cutChanged = newCut !== oldCut.toString();

        if (!metadataChanged && !cutChanged) {
            UI.setModalState('operator-settings-modal', 'input');
            UI.showCustomAlert('No Changes', 'You have not made any changes.');
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Confirm Changes';
            return;
        }

        let txHash1 = null;
        let txHash2 = null;

        try {
            if (metadataChanged) {
                UI.setModalState('operator-settings-modal', 'loading', { text: "Updating Metadata...", subtext: "Please confirm in your wallet." });
                const newMetadata = {
                    name: newName,
                    description: newDescription,
                    imageIpfsCid: oldMetadata.imageUrl ? oldMetadata.imageUrl.split('/').pop() : null,
                    redundancyFactor: parseInt(newRedundancy, 10)
                };
                txHash1 = await Services.updateOperatorMetadata(state.signer, state.currentOperatorId, JSON.stringify(newMetadata));
                if (!txHash1) {
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = 'Confirm Changes';
                    return;
                }
            }

            if (cutChanged) {
                UI.setModalState('operator-settings-modal', 'loading', { text: "Updating Owner's Cut...", subtext: "Please confirm in your wallet." });
                txHash2 = await Services.updateOperatorCut(state.signer, state.currentOperatorId, newCut);
                if (!txHash2) {
                     confirmBtn.disabled = false;
                     confirmBtn.textContent = 'Confirm Changes';
                     return;
                }
            }

            UI.setModalState('operator-settings-modal', 'success', {
                txHash: txHash1,
                tx1Text: txHash1 ? "Metadata Update Successful!" : "",
                txHash2: txHash2,
                tx2Text: txHash2 ? "Owner's Cut Update Successful!" : ""
            });
            
            await refreshOperatorData(true);

        } catch (e) {
            UI.setModalState('operator-settings-modal', 'error', { message: Utils.getFriendlyErrorMessage(e) });
        } finally {
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Confirm Changes';
        }
    });
}


// --- Streamr Coordination Stream ---
function setupOperatorStream() {
    Services.setupStreamrSubscription(state.currentOperatorId, (message) => {
        UI.addStreamMessageToUI(message, state.activeNodes, state.unreachableNodes);
    });
}

// --- Event Listener Setup ---

function setupEventListeners() {
    document.getElementById('connectWalletBtn').addEventListener('click', connectWithWallet);
    document.getElementById('guestBtn').addEventListener('click', connectAsGuest);
    document.getElementById('closeAlertBtn').addEventListener('click', () => UI.customAlertModal.classList.add('hidden'));

    UI.walletInfoEl.addEventListener('click', () => {
        if (!state.myRealAddress) {
            connectWithWallet();
        }
    });

    UI.searchInput.addEventListener('input', (e) => handleSearch(e.target.value));
    document.getElementById('load-more-operators-btn').addEventListener('click', (e) => handleLoadMoreOperators(e.target));
    
    document.getElementById('back-to-list-btn').addEventListener('click', () => {
        if (state.detailsRefreshInterval) clearInterval(state.detailsRefreshInterval);
        Services.unsubscribeFromCoordinationStream();
        UI.displayView('list');
		state.loadedOperatorCount = 0;
        fetchAndRenderOperatorsList(false, 0, state.searchQuery);
    });

    // --- RACE LISTENERS ---
    const raceBtn = document.getElementById('race-view-btn');
    if (raceBtn) {
        raceBtn.addEventListener('click', handleShowRace);
    }

    const raceBackBtn = document.getElementById('race-back-to-list-btn');
    if (raceBackBtn) {
        raceBackBtn.addEventListener('click', handleBackToFromRace);
    }

    // --- VISUAL VIEW LISTENERS ---
    const visualBtn = document.getElementById('visual-view-btn');
    if (visualBtn) {
        visualBtn.addEventListener('click', handleShowVisual);
    }

    const visualBackBtn = document.getElementById('vis-btn-back');
    if (visualBackBtn) {
        visualBackBtn.addEventListener('click', handleBackFromVisual);
    }

    // Modals
    document.getElementById('tx-modal-cancel').addEventListener('click', () => UI.transactionModal.classList.add('hidden'));
    document.getElementById('tx-modal-close').addEventListener('click', () => UI.transactionModal.classList.add('hidden'));
    document.getElementById('stake-modal-cancel').addEventListener('click', () => UI.stakeModal.classList.add('hidden'));
    document.getElementById('stake-modal-close').addEventListener('click', () => UI.stakeModal.classList.add('hidden'));
    document.getElementById('operator-settings-modal-cancel').addEventListener('click', () => UI.operatorSettingsModal.classList.add('hidden'));
    document.getElementById('operator-settings-modal-close').addEventListener('click', () => UI.operatorSettingsModal.classList.add('hidden'));
    
    // Settings
    document.getElementById('settings-btn').addEventListener('click', () => {
        UI.theGraphApiKeyInput.value = localStorage.getItem('the-graph-api-key') || '';
        document.getElementById('etherscan-api-key-input').value = localStorage.getItem('etherscan-api-key') || '';
        UI.settingsModal.classList.remove('hidden');
    });
    document.getElementById('settings-cancel-btn').addEventListener('click', () => UI.settingsModal.classList.add('hidden'));
    document.getElementById('settings-save-btn').addEventListener('click', () => {
        const newGraphKey = UI.theGraphApiKeyInput.value.trim();
        if (newGraphKey) {
            localStorage.setItem('the-graph-api-key', newGraphKey);
        } else {
            localStorage.removeItem('the-graph-api-key');
        }
        Services.updateGraphApiKey(newGraphKey);
        
        const newEtherscanKey = document.getElementById('etherscan-api-key-input').value.trim();
        if (newEtherscanKey) {
            localStorage.setItem('etherscan-api-key', newEtherscanKey);
        } else {
            localStorage.removeItem('etherscan-api-key');
        }
        Services.updateEtherscanApiKey(newEtherscanKey);
        
        UI.settingsModal.classList.add('hidden');
        UI.showCustomAlert('Settings Saved', 'Data will be refreshed with the new API keys.');
        
        state.loadedOperatorCount = 0;
        fetchAndRenderOperatorsList(false, 0, state.searchQuery);
    });
    
    document.body.addEventListener('click', (e) => {
        const target = e.target;

        const operatorCard = target.closest('.card, .operator-link');
        if (operatorCard && operatorCard.dataset.operatorId) {
            e.preventDefault();
            handleShowOperatorDetails(operatorCard.dataset.operatorId);
            return;
        }

        if (target.id === 'delegate-btn') handleDelegateClick();
        if (target.id === 'undelegate-btn') handleUndelegateClick();
        if (target.id === 'process-queue-btn') handleProcessQueueClick(target);
        if (target.id === 'collect-all-earnings-btn') handleCollectAllEarningsClick(target);
        if (target.id === 'load-more-delegators-btn') handleLoadMoreDelegators(target);
        if (target.id === 'edit-operator-settings-btn') handleEditOperatorSettingsClick();
        
        if (target.closest('#toggle-stats-btn')) UI.toggleStatsPanel(false, state.uiState);
        if (target.id === 'toggle-delegator-view-btn') {
            UI.toggleDelegatorQueueView(state.currentOperatorData, state.uiState);
            if(state.uiState.isDelegatorViewActive) {
                UI.updateDelegatorsSection(state.currentDelegations, state.totalDelegatorCount);
            }
        }
        if (target.id === 'toggle-reputation-view-btn') UI.toggleReputationView(false, state.uiState);
        if (target.id === 'toggle-wallets-view-btn') UI.toggleWalletsView(false, state.uiState);
        if (target.id === 'toggle-sponsorship-view-btn') {
            UI.toggleSponsorshipsView(state.uiState, state.currentOperatorData);
            if (!state.uiState.isSponsorshipsListViewActive) {
                 UI.renderSponsorshipsHistory(state.sponsorshipHistory);
            }
        }
        if (target.closest('.toggle-vote-list-btn')) UI.toggleVoteList(target.closest('.toggle-vote-list-btn').dataset.flagId);

        // Chart Timeframe
        const timeframeButton = target.closest('#chart-timeframe-buttons button');
        if (timeframeButton && timeframeButton.dataset.days) {
            const days = timeframeButton.dataset.days === 'all' ? 'all' : parseInt(timeframeButton.dataset.days, 10);
            state.chartTimeFrame = days;
            filterAndRenderChart();
            return;
        }

        // Chart View (DATA/USD)
        const chartViewButton = target.closest('#chart-view-buttons button');
        if (chartViewButton && chartViewButton.dataset.view) {
            state.uiState.isChartUsdView = (chartViewButton.dataset.view === 'usd');
            filterAndRenderChart();
            return;
        }

        const menuBtn = target.closest('.toggle-sponsorship-menu-btn');
        if (menuBtn) {
            e.stopPropagation();
            const sponsorshipId = menuBtn.dataset.sponsorshipId;
            const menu = document.getElementById(`sponsorship-menu-${sponsorshipId}`);
            if (state.activeSponsorshipMenu && state.activeSponsorshipMenu !== menu) {
                state.activeSponsorshipMenu.classList.add('hidden');
            }
            menu.classList.toggle('hidden');
            state.activeSponsorshipMenu = menu.classList.contains('hidden') ? null : menu;
        } else {
             if (state.activeSponsorshipMenu) {
                state.activeSponsorshipMenu.classList.add('hidden');
                state.activeSponsorshipMenu = null;
            }
        }
        
        const editStakeLink = target.closest('.edit-stake-link');
        if(editStakeLink) {
            e.preventDefault();
            handleEditStakeClick(editStakeLink.dataset.sponsorshipId, editStakeLink.dataset.currentStake);
        }
        
        const collectEarningsLink = target.closest('.collect-earnings-link');
        if(collectEarningsLink) {
            e.preventDefault();
            if (collectEarningsLink.classList.contains('processing')) return;
            handleCollectEarningsClick(collectEarningsLink, collectEarningsLink.dataset.sponsorshipId);
        }
    });

    UI.mainContainer.addEventListener('mouseover', (e) => {
        const target = e.target.closest('[data-tooltip-value], [data-tooltip-content]');
        if (!target) return;
        const content = target.dataset.tooltipContent || Utils.formatUsdForTooltip(target.dataset.tooltipValue, state.dataPriceUSD);
        if (content) {
            UI.customTooltip.textContent = content;
            UI.customTooltip.classList.remove('hidden');
        }
    });
    UI.mainContainer.addEventListener('mousemove', (e) => {
        if (!UI.customTooltip.classList.contains('hidden')) {
            UI.customTooltip.style.left = `${e.pageX + 15}px`;
            UI.customTooltip.style.top = `${e.pageY + 15}px`;
        }
    });
    UI.mainContainer.addEventListener('mouseout', (e) => {
        if (e.target.closest('[data-tooltip-value], [data-tooltip-content]')) {
            UI.customTooltip.classList.add('hidden');
        }
    });
}


// --- App Entry Point ---
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    UI.loginModal.classList.remove('hidden');
});