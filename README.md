# Survey Web App

This repository contains a simple Flask-based web application for creating and managing online surveys. Users can design surveys through a basic GUI, collect responses, view aggregated results, and export answers in JSON format for integration with external systems.

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

- Create surveys with any number of questions.
- Respond to surveys via a web form.
- View result summaries with counts per answer.
- Export survey results as JSON.

Data is stored locally in a SQLite database (`survey.db`).
