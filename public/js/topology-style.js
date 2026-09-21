// Static Cytoscape style array for the topology graph -- factored out of
// topology-render.js purely so that file stays focused on element
// construction (what's a node, what's an edge, what the multi-endpoint hub
// wrinkle needs) rather than also carrying this much presentation detail.
function topologyGraphStyle() {
  return [
    {
      selector: 'node',
      style: {
        'background-color': '#0d0d0d',
        'border-width': 2,
        'border-color': '#6b6b6b',
        label: 'data(label)',
        color: '#d4d4d4',
        'font-family': 'JetBrains Mono, ui-monospace, Menlo, monospace',
        'font-size': 11,
        'text-valign': 'bottom',
        'text-margin-y': 6,
        'text-wrap': 'wrap',
        'line-height': 1.3,
        width: 44,
        height: 44,
      },
    },
    { selector: 'node[?running]', style: { 'border-color': '#27c93f' } },
    // Hub nodes (an external bridge or shared segment, not a real device)
    // render smaller/dimmer with a dashed border so they read as "a
    // network," not "a device" -- same idea as the old project's
    // extra_interfaces stub nodes, repurposed here for multi-endpoint
    // links instead.
    {
      selector: 'node[?isHub]',
      style: { width: 20, height: 20, 'font-size': 9, 'border-color': '#3a3a3a', 'border-style': 'dashed', 'text-margin-y': 4 },
    },
    {
      // source-label/target-label render two separate labels, each
      // positioned near its own end of the edge -- so it's always clear
      // which interface name belongs to which device, instead of one
      // ambiguous label floating at the midpoint.
      selector: 'edge',
      style: {
        width: 2,
        'line-color': '#333',
        'curve-style': 'bezier',
        'source-label': 'data(sourceLabel)',
        'target-label': 'data(targetLabel)',
        'source-text-offset': 28,
        'target-text-offset': 28,
        color: '#6b6b6b',
        'font-family': 'JetBrains Mono, ui-monospace, Menlo, monospace',
        'font-size': 9,
        'text-background-color': '#060606',
        'text-background-opacity': 1,
        'text-background-padding': 2,
      },
    },
    {
      selector: 'edge[?isHubSpoke]',
      style: {
        'line-color': '#3a3a3a',
        'line-style': 'dashed',
        'target-arrow-shape': 'none',
        label: 'data(label)',
        'font-size': 9,
        color: '#6b6b6b',
        'text-background-color': '#060606',
        'text-background-opacity': 1,
        'text-background-padding': 2,
      },
    },
  ];
}
