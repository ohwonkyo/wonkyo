# Survey Web App

This repository contains a Flask-based survey platform. Through a graphical web interface you can design rich surveys, collect responses, analyse results and export data for use in other systems.

## Setup

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
2. Run the application:
   ```bash
   python app.py
   ```
3. Open a browser and navigate to `http://localhost:5000`.

## Features

- Create surveys with many question types including multiple choice, text, scale, matrix, file upload and more.
- Conditional branching and input validation (numeric or alphabetic only).
- View aggregated results and individual free‑text responses.
- Export survey results as JSON for integration with external systems.

Data is stored locally in a SQLite database (`survey.db`).
