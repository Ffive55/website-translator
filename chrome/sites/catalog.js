// 自动生成，请修改 sites/<id>/site.json
const SUPPORTED_SITES = [
  {
    "id": "docker",
    "name": "Docker 官网",
    "matches": [
      "https://docker.com/*",
      "https://www.docker.com/*"
    ],
    "engine": "dictionary"
  },
  {
    "id": "docker-hub",
    "name": "Docker 工作台与 Hub",
    "matches": [
      "https://app.docker.com/*",
      "https://hub.docker.com/*"
    ],
    "engine": "dictionary"
  },
  {
    "id": "github",
    "name": "GitHub",
    "matches": [
      "https://github.com/*",
      "https://skills.github.com/*",
      "https://gist.github.com/*",
      "https://education.github.com/*",
      "https://www.githubstatus.com/*"
    ],
    "engine": "github"
  },
  {
    "id": "tailscale",
    "name": "Tailscale",
    "matches": [
      "https://tailscale.com/*",
      "https://www.tailscale.com/*",
      "https://login.tailscale.com/*",
      "https://console.tailscale.com/*"
    ],
    "engine": "dictionary"
  }
];
